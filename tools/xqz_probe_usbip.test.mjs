// Tests xqz_probe_usbip.mjs against a minimal in-process USB/IP server that mimics usbipd-win.
// Run: node --test tools/xqz_probe_usbip.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ECONNRESET,
  formatBytes,
  listDevices,
  parseConfiguration,
  USBIP_CMD_SUBMIT,
  USBIP_CMD_UNLINK,
  USBIP_RET_SUBMIT,
  USBIP_RET_UNLINK,
  USBIP_VERSION
} from './xqz_probe_usbip.mjs';

const SCRIPT = fileURLToPath(new URL('./xqz_probe_usbip.mjs', import.meta.url));
const BUSID = '2-3';

const DEVICE_DESCRIPTOR = Buffer.from([
  18, 1, 0x00, 0x02, 0, 0, 0, 64, 0x4c, 0x05, 0x48, 0x0e, 0x00, 0x01, 1, 2, 3, 1
]);

const CONFIG_DESCRIPTOR = Buffer.from([
  9, 2, 32, 0, 1, 1, 0, 0x80, 50,
  9, 4, 0, 0, 2, 0xff, 0x01, 0x01, 0,
  7, 5, 0x02, 0x02, 16, 0, 0,
  7, 5, 0x81, 0x02, 16, 0, 0
]);

const STRINGS = ['', 'Sony', 'XQZ-IV01', 'SN123'];

function stringDescriptor(index) {
  if (index === 0) {
    return Buffer.from([4, 3, 0x09, 0x04]);
  }

  const text = Buffer.from(STRINGS[index], 'utf16le');

  return Buffer.concat([Buffer.from([2 + text.length, 3]), text]);
}

function deviceStruct() {
  const buffer = Buffer.alloc(312);

  buffer.write('USB\\VID_054C&PID_0E48\\5&123', 0);
  buffer.write(BUSID, 256);
  buffer.writeUInt32BE(2, 288);
  buffer.writeUInt32BE(3, 292);
  buffer.writeUInt32BE(2, 296);
  buffer.writeUInt16BE(0x054c, 300);
  buffer.writeUInt16BE(0x0e48, 302);
  buffer.writeUInt16BE(0x0100, 304);
  buffer[309] = 1;
  buffer[310] = 1;
  buffer[311] = 1;

  return buffer;
}

function opReply(code, status) {
  const buffer = Buffer.alloc(8);

  buffer.writeUInt16BE(USBIP_VERSION, 0);
  buffer.writeUInt16BE(code, 2);
  buffer.writeUInt32BE(status, 4);

  return buffer;
}

function retSubmit(seqnum, status, data, actualLength = data.length) {
  const header = Buffer.alloc(48);

  header.writeUInt32BE(USBIP_RET_SUBMIT, 0);
  header.writeUInt32BE(seqnum, 4);
  header.writeInt32BE(status, 20);
  header.writeInt32BE(actualLength, 24);

  return Buffer.concat([header, data]);
}

function startServer({ exported = true, dropAfterShows = 0 } = {}) {
  const state = { configured: 0, tx: [], unlinked: 0, imports: 0, closed: 0, errors: [] };

  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let phase = 'op';
    let parkedRead = null;
    const rxQueue = [];

    const deliver = () => {
      if (parkedRead && rxQueue.length) {
        socket.write(retSubmit(parkedRead.seqnum, 0, rxQueue.shift()));
        parkedRead = null;
      }
    };

    const fail = message => {
      state.errors.push(message);
      socket.destroy();
    };

    socket.on('close', () => state.closed++);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (phase === 'op') {
          if (buffer.length < 8) {
            return;
          }

          const code = buffer.readUInt16BE(2);

          if (buffer.readUInt16BE(0) !== USBIP_VERSION) {
            return fail('bad version');
          }

          if (code === 0x8005) {
            buffer = buffer.subarray(8);

            const count = Buffer.alloc(4);

            count.writeUInt32BE(exported ? 1 : 0);
            socket.end(
              Buffer.concat([opReply(0x0005, 0), count, ...(exported ? [deviceStruct(), Buffer.from([0xff, 1, 1, 0])] : [])])
            );

            return;
          }

          if (code === 0x8003) {
            if (buffer.length < 40) {
              return;
            }

            const busid = buffer.subarray(8, 40).toString().replace(/\0.*$/s, '');

            buffer = buffer.subarray(40);
            state.imports++;

            if (busid !== BUSID || !exported) {
              socket.end(opReply(0x0003, 4));

              return;
            }

            socket.write(Buffer.concat([opReply(0x0003, 0), deviceStruct()]));
            phase = 'urb';
            continue;
          }

          return fail(`bad opcode ${code}`);
        }

        if (buffer.length < 48) {
          return;
        }

        const command = buffer.readUInt32BE(0);
        const seqnum = buffer.readUInt32BE(4);

        if (buffer.readUInt32BE(8) !== ((2 << 16) | 3)) {
          return fail('bad devid');
        }

        if (command === USBIP_CMD_UNLINK) {
          const target = buffer.readUInt32BE(20);
          const won = parkedRead?.seqnum === target;
          const reply = Buffer.alloc(48);

          buffer = buffer.subarray(48);

          if (won) {
            parkedRead = null;
            state.unlinked++;
          }

          reply.writeUInt32BE(USBIP_RET_UNLINK, 0);
          reply.writeUInt32BE(seqnum, 4);
          reply.writeInt32BE(won ? -ECONNRESET : 0, 20);
          socket.write(reply);
          continue;
        }

        if (command !== USBIP_CMD_SUBMIT) {
          return fail(`bad command ${command}`);
        }

        const directionIn = buffer.readUInt32BE(12) === 1;
        const endpoint = buffer.readUInt32BE(16);
        const length = buffer.readInt32BE(24);
        const numberOfPackets = buffer.readInt32BE(32);
        const interval = buffer.readInt32BE(36);
        const setup = buffer.subarray(40, 48);
        const total = 48 + (directionIn ? 0 : length);

        if (numberOfPackets > 0 || interval !== 0) {
          return fail('usbipd-win would treat this as ISO/interrupt');
        }

        if (buffer.length < total) {
          return;
        }

        const data = buffer.subarray(48, total);

        buffer = buffer.subarray(total);

        if (endpoint === 0) {
          const [requestType, request] = setup;
          const value = setup.readUInt16LE(2);
          const wLength = setup.readUInt16LE(6);

          if (requestType === 0x80 && request === 6) {
            const type = value >> 8;
            const descriptor =
              type === 1 ? DEVICE_DESCRIPTOR
              : type === 2 ? CONFIG_DESCRIPTOR
              : type === 3 ? stringDescriptor(value & 0xff)
              : null;

            socket.write(descriptor ? retSubmit(seqnum, 0, descriptor.subarray(0, wLength)) : retSubmit(seqnum, -32, Buffer.alloc(0)));
          } else if (requestType === 0x00 && request === 9) {
            state.configured = value;
            socket.write(retSubmit(seqnum, 0, Buffer.alloc(0)));
          } else {
            socket.write(retSubmit(seqnum, -32, Buffer.alloc(0)));
          }

          continue;
        }

        if (!state.configured) {
          // VBoxUSB has no pipe handles before SET_CONFIGURATION.
          socket.write(retSubmit(seqnum, -71, Buffer.alloc(0)));
          continue;
        }

        if (endpoint === 2 && !directionIn) {
          const text = data.toString();

          state.tx.push(text);
          socket.write(retSubmit(seqnum, 0, Buffer.alloc(0), data.length));

          const shows = state.tx.filter(t => t === 'show').length;

          if (dropAfterShows && shows >= dropAfterShows) {
            // Like usbipd-win on unplug or `usbipd unbind`.
            socket.destroy();

            return;
          }

          if (text === 'show' && shows === 1) {
            rxQueue.push(Buffer.from('disp_on'), Buffer.from('flip'));
          } else if (text === 'stop') {
            rxQueue.push(Buffer.from('disp_off'));
          }

          deliver();
        } else if (endpoint === 1 && directionIn) {
          if (length !== 16) {
            return fail(`unexpected read length ${length}`);
          }

          parkedRead = { seqnum };
          deliver();
        } else {
          return fail(`unexpected endpoint ${endpoint}`);
        }
      }
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function runProbe(args, { interruptAfterMs } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args]);

    if (interruptAfterMs) {
      setTimeout(() => child.kill('SIGINT'), interruptAfterMs);
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('formatBytes matches Python repr', () => {
  assert.equal(formatBytes(Buffer.from("flip\r'\\\x00")), "b'flip\\r\\'\\\\\\x00'");
});

test('parseConfiguration finds bulk endpoints', () => {
  const configuration = parseConfiguration(CONFIG_DESCRIPTOR);

  assert.equal(configuration.value, 1);
  assert.deepEqual(
    configuration.interfaces[0].endpoints.map(e => e.address),
    [0x02, 0x81]
  );
});

test('listDevices parses OP_REP_DEVLIST', async () => {
  const { server, port } = await startServer();

  try {
    const [device] = await listDevices('127.0.0.1', port);

    assert.equal(device.busid, BUSID);
    assert.equal(device.idVendor, 0x054c);
    assert.equal(device.idProduct, 0x0e48);
    assert.deepEqual(device.interfaces, [{ class: 0xff, subClass: 1, protocol: 1 }]);
  } finally {
    server.close();
  }
});

test('heartbeat, RX, flip and stop over USB/IP', async () => {
  const { server, state, port } = await startServer();

  try {
    const { code, stdout, stderr } = await runProbe(['--port', String(port), '--duration', '1']);

    assert.equal(code, 0, stderr);
    assert.match(stdout, /device 0x054c:0x0e48 busid=2-3 bus=2 address=3/);
    assert.match(stdout, /manufacturer: Sony/);
    assert.match(stdout, /product {5}: XQZ-IV01/);
    assert.match(stdout, /interface 0 alt=0 class=0xff\/0x01\/0x01/);
    assert.match(stdout, /endpoint 0x0081 IN  bulk {8}maxPacket=16/);
    assert.match(stdout, /using interface 0 \(bulk OUT 0x0002, bulk IN 0x0081\)/);
    assert.match(stdout, /RX b'disp_on' {2}-> {2}'disp_on'/);
    assert.match(stdout, /\[FLIP button pressed\]/);
    assert.match(stdout, /duration reached \(1s\)/);
    assert.match(stdout, /TX b'stop'/);
    assert.match(stdout, /RX b'disp_off'/);
    assert.equal(state.configured, 1);
    assert.ok(state.tx.filter(t => t === 'show').length >= 3, state.tx.join());
    assert.equal(state.tx.at(-1), 'stop');
    assert.equal(state.unlinked, 1);
    assert.deepEqual(state.errors, []);
  } finally {
    server.close();
  }
});

test('--no-show only listens', async () => {
  const { server, state, port } = await startServer();

  try {
    const { code, stdout } = await runProbe(['--port', String(port), '--busid', BUSID, '--no-show', '--duration', '0.3']);

    assert.equal(code, 0);
    assert.match(stdout, /listening; Ctrl-C to exit/);
    assert.deepEqual(state.tx, ['stop']);
  } finally {
    server.close();
  }
});

test('reports a device that is not shared', async () => {
  const { server, port } = await startServer({ exported: false });

  try {
    const { code, stderr } = await runProbe(['--port', String(port)]);

    assert.equal(code, 1);
    assert.match(stderr, /usbipd bind --busid/);
  } finally {
    server.close();
  }
});

test('--list prints exported devices', async () => {
  const { server, port } = await startServer();

  try {
    const { code, stdout } = await runProbe(['--port', String(port), '--list']);

    assert.equal(code, 0);
    assert.match(stdout, /2-3 {6}0x054c:0x0e48 speed=full interfaces=\[0xff\/0x01\/0x01\]/);
  } finally {
    server.close();
  }
});

// child.kill('SIGINT') terminates the process on Windows instead of raising SIGINT.
test('Ctrl-C sends stop and releases the device', { skip: process.platform === 'win32' }, async () => {
  const { server, state, port } = await startServer();

  try {
    const { code, stdout } = await runProbe(['--port', String(port)], { interruptAfterMs: 700 });

    assert.equal(code, 0);
    assert.match(stdout, /\ninterrupted\nTX b'stop'/);
    assert.equal(state.tx.at(-1), 'stop');
    assert.equal(state.unlinked, 1);
  } finally {
    server.close();
  }
});

test('exits when usbipd-win drops the device', async () => {
  const { server, port } = await startServer({ dropAfterShows: 2 });

  try {
    const { code, stdout, stderr } = await runProbe(['--port', String(port)]);

    assert.equal(code, 1);
    assert.match(stdout + stderr, /device disconnected|TX error/);
    assert.doesNotMatch(stdout, /TX b'stop'/);
  } finally {
    server.close();
  }
});
