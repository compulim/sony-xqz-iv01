#!/usr/bin/env node
/*
Probe the control channel of the Sony XQZ-IV01 Vlog Monitor via usbipd-win.

What this does
--------------
Same as xqz_probe.py, but instead of opening the USB device directly it speaks
the USB/IP protocol to usbipd-win (https://github.com/dorssel/usbipd-win) over
TCP port 3240. No WinUSB/Zadig driver swap and no WSL are needed: usbipd-win
captures the device and this script acts as the USB/IP client (like
`usbip attach`, but in user space).

The monitor is a USB-C DisplayPort Alt-Mode sink plus a small vendor USB
device (VID:PID 054c:0e48). The camera apps talk to the vendor device over a
bulk OUT/IN pair on interface 0 with raw ASCII commands:

    phone -> monitor : "show"  (enables the DP sink + panel; 1.000 s watchdog)
                       "stop"  (drops the DP link / blanks the panel)
    monitor -> phone : "disp_on" / "disp_off"  (ACKs, ignored by Sony's apps)
                       "flip"                 (FLIP button pressed)

Only the control device (054c:0e48) is touched; the USB Audio Class device
(054c:0e49) that appears with "show" active and a mic plugged is not handled.

Requirements
------------
    Node.js 18+ (no npm packages).
    usbipd-win installed and running, with the device shared once from an
    elevated prompt:
        usbipd list
        usbipd bind --busid <BUSID>
    The device must not be attached elsewhere (e.g. `usbipd detach --busid <BUSID>`).
    While this script runs, Windows loses the device; it is returned on exit.

Usage
-----
    node xqz_probe_usbip.mjs                 dump descriptors, heartbeat, print RX
    node xqz_probe_usbip.mjs --duration 10   run for 10 s, send "stop", exit
    node xqz_probe_usbip.mjs --no-show       only dump descriptors and listen
    node xqz_probe_usbip.mjs --interface 1   override interface index
    node xqz_probe_usbip.mjs --list          list devices exported by usbipd-win

Options
-------
    --host <host>     usbipd-win host (default 127.0.0.1)
    --port <n>        usbipd-win TCP port (default 3240)
    --busid <id>      bus ID to attach (default: find by --vid/--pid)
    --vid <id>        vendor ID (default 0x054c)
    --pid <id>        product ID (default 0x0e48)
    --interface <n>   interface index (default: auto, prefer 0)
    --interval <s>    seconds between "show" heartbeats (default 0.4)
    --no-show         do not send "show"; just dump descriptors and read
    --duration <s>    run for N seconds, then send "stop" and exit (0 = forever)
    --list            list exported devices and exit
    -h, --help        show this help

Press Ctrl-C to send "stop" and exit.
*/

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const USBIP_PORT = 3240;
export const USBIP_VERSION = 0x0111;

export const OP_REQ_DEVLIST = 0x8005;
export const OP_REP_DEVLIST = 0x0005;
export const OP_REQ_IMPORT = 0x8003;
export const OP_REP_IMPORT = 0x0003;

export const USBIP_CMD_SUBMIT = 1;
export const USBIP_CMD_UNLINK = 2;
export const USBIP_RET_SUBMIT = 3;
export const USBIP_RET_UNLINK = 4;

export const USBIP_DIR_OUT = 0;
export const USBIP_DIR_IN = 1;

export const SYSFS_PATH_MAX = 256;
export const SYSFS_BUS_ID_SIZE = 32;
export const USBIP_DEVICE_SIZE = 312;
export const USBIP_HEADER_SIZE = 48;

export const ECONNRESET = 104;
const ETIMEDOUT = 110;

const DEFAULT_VID = 0x054c;
const DEFAULT_PID = 0x0e48;
const DEFAULT_INTERVAL = 0.4;
const CONTROL_TIMEOUT_MS = 5000;
const BULK_OUT_TIMEOUT_MS = 500;

const OP_STATUS = ['ST_OK', 'ST_NA', 'ST_DEV_BUSY', 'ST_DEV_ERR', 'ST_NODEV', 'ST_ERROR'];

const ERRNO = {
  2: 'ENOENT',
  19: 'ENODEV',
  32: 'EPIPE (stall)',
  62: 'ETIME',
  71: 'EPROTO',
  75: 'EOVERFLOW',
  84: 'EILSEQ',
  104: 'ECONNRESET (unlinked)',
  108: 'ESHUTDOWN',
  110: 'ETIMEDOUT',
  121: 'EREMOTEIO'
};

const SPEED = { 1: 'low', 2: 'full', 3: 'high', 4: 'wireless', 5: 'super', 6: 'super+' };

export const hexId = value => `0x${value.toString(16).padStart(4, '0')}`;
const hexByte = value => `0x${value.toString(16).padStart(2, '0')}`;
const errnoName = status => (status ? `${ERRNO[-status] ?? 'errno'} (${status})` : 'OK');

function cString(buffer) {
  const end = buffer.indexOf(0);

  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
}

/** Python-style bytes repr, e.g. b'disp_on\r'. */
export function formatBytes(data) {
  let text = "b'";

  for (const value of data) {
    text +=
      value === 0x5c ? '\\\\'
      : value === 0x27 ? "\\'"
      : value === 0x0d ? '\\r'
      : value === 0x0a ? '\\n'
      : value === 0x09 ? '\\t'
      : value >= 0x20 && value < 0x7f ? String.fromCharCode(value)
      : `\\x${value.toString(16).padStart(2, '0')}`;
  }

  return `${text}'`;
}

/** Waits for `promise`, but at most `ms`; never keeps the event loop alive afterwards. */
async function settleWithin(promise, ms) {
  let timer;

  await Promise.race([promise.catch(() => {}), new Promise(resolve => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

const quote = text => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

export class UsbError extends Error {
  constructor(message, status) {
    super(`${message}: ${errnoName(status)}`);
    this.status = status;
  }
}

/** Buffers socket data so fixed-size messages can be awaited. */
class SocketReader {
  #chunks = [];
  #length = 0;
  #waiter = null;
  #error = null;

  constructor(socket) {
    socket.on('data', chunk => {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
      this.#pump();
    });
    socket.on('end', () => this.#fail(new Error('connection closed by usbipd')));
    socket.on('close', () => this.#fail(new Error('connection closed')));
    socket.on('error', error => this.#fail(error));
  }

  read(length) {
    return new Promise((resolve, reject) => {
      this.#waiter = { length, resolve, reject };
      this.#pump();
    });
  }

  #pump() {
    const waiter = this.#waiter;

    if (!waiter) {
      return;
    }

    if (this.#length >= waiter.length) {
      const buffer = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks);

      this.#chunks = buffer.length > waiter.length ? [buffer.subarray(waiter.length)] : [];
      this.#length -= waiter.length;
      this.#waiter = null;
      waiter.resolve(buffer.subarray(0, waiter.length));
    } else if (this.#error) {
      this.#waiter = null;
      waiter.reject(this.#error);
    }
  }

  #fail(error) {
    this.#error ??= error;
    this.#pump();
  }
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });

    socket.once('connect', () => {
      socket.off('error', reject);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') {
        error.message = `cannot connect to usbipd-win at ${host}:${port} (is the usbipd service running?)`;
      }

      reject(error);
    });
  });
}

function opHeader(code) {
  const buffer = Buffer.alloc(8);

  buffer.writeUInt16BE(USBIP_VERSION, 0);
  buffer.writeUInt16BE(code, 2);
  buffer.writeUInt32BE(0, 4);

  return buffer;
}

async function readOpReply(reader, expectedCode) {
  const header = await reader.read(8);
  const version = header.readUInt16BE(0);
  const code = header.readUInt16BE(2);
  const status = header.readUInt32BE(4);

  if (version !== USBIP_VERSION) {
    throw new Error(`USB/IP version mismatch: got ${hexId(version)}`);
  }

  if (code !== expectedCode) {
    throw new Error(`unexpected USB/IP reply ${hexId(code)}`);
  }

  return status;
}

/** Parses struct usbip_usb_device (312 bytes). */
export function parseDevice(buffer) {
  return {
    path: cString(buffer.subarray(0, SYSFS_PATH_MAX)),
    busid: cString(buffer.subarray(SYSFS_PATH_MAX, SYSFS_PATH_MAX + SYSFS_BUS_ID_SIZE)),
    busnum: buffer.readUInt32BE(288),
    devnum: buffer.readUInt32BE(292),
    speed: buffer.readUInt32BE(296),
    idVendor: buffer.readUInt16BE(300),
    idProduct: buffer.readUInt16BE(302),
    bcdDevice: buffer.readUInt16BE(304),
    bDeviceClass: buffer[306],
    bDeviceSubClass: buffer[307],
    bDeviceProtocol: buffer[308],
    bConfigurationValue: buffer[309],
    bNumConfigurations: buffer[310],
    bNumInterfaces: buffer[311],
    interfaces: []
  };
}

/** OP_REQ_DEVLIST: devices usbipd-win is willing to export (i.e. bound/shared). */
export async function listDevices(host = '127.0.0.1', port = USBIP_PORT) {
  const socket = await connect(host, port);

  try {
    const reader = new SocketReader(socket);

    socket.write(opHeader(OP_REQ_DEVLIST));

    const status = await readOpReply(reader, OP_REP_DEVLIST);

    if (status !== 0) {
      throw new Error(`device list failed: ${OP_STATUS[status] ?? status}`);
    }

    const count = (await reader.read(4)).readUInt32BE(0);
    const devices = [];

    for (let index = 0; index < count; index++) {
      const device = parseDevice(await reader.read(USBIP_DEVICE_SIZE));

      for (let number = 0; number < device.bNumInterfaces; number++) {
        const data = await reader.read(4);

        device.interfaces.push({ class: data[0], subClass: data[1], protocol: data[2] });
      }

      devices.push(device);
    }

    return devices;
  } finally {
    socket.destroy();
  }
}

/** An imported (attached) USB/IP device: submits URBs over the TCP connection. */
export class UsbipDevice {
  #socket;
  #reader;
  #seqnum = 0;
  #pending = new Map();
  #unlinks = new Map();
  #closing = false;

  constructor(socket, reader, device) {
    this.#socket = socket;
    this.#reader = reader;
    this.device = device;
    this.devid = ((device.busnum << 16) | device.devnum) >>> 0;
    this.closed = this.#run();
  }

  /** OP_REQ_IMPORT: usbipd-win captures the device for the lifetime of the connection. */
  static async import(host, port, busid) {
    const socket = await connect(host, port);
    const reader = new SocketReader(socket);
    const request = Buffer.alloc(8 + SYSFS_BUS_ID_SIZE);

    opHeader(OP_REQ_IMPORT).copy(request);
    request.write(busid, 8, SYSFS_BUS_ID_SIZE - 1, 'utf8');
    socket.write(request);

    try {
      const status = await readOpReply(reader, OP_REP_IMPORT);

      if (status !== 0) {
        const name = OP_STATUS[status] ?? `status ${status}`;
        const hint =
          status === 2 ? ' (already attached, e.g. to WSL? run `usbipd detach --busid ' + busid + '`)'
          : status === 4 ? ' (not shared? run `usbipd bind --busid ' + busid + '` as administrator)'
          : '';

        throw new Error(`import of ${busid} failed: ${name}${hint}`);
      }

      return new UsbipDevice(socket, reader, parseDevice(await reader.read(USBIP_DEVICE_SIZE)));
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  async #run() {
    try {
      for (;;) {
        const header = await this.#reader.read(USBIP_HEADER_SIZE);
        const command = header.readUInt32BE(0);
        const seqnum = header.readUInt32BE(4);
        const status = header.readInt32BE(20);

        if (command === USBIP_RET_SUBMIT) {
          const pending = this.#pending.get(seqnum);

          if (!pending) {
            throw new Error(`RET_SUBMIT for unknown seqnum ${seqnum}`);
          }

          const actualLength = header.readInt32BE(24);
          const data =
            pending.directionIn && actualLength > 0 ? Buffer.from(await this.#reader.read(actualLength)) : Buffer.alloc(0);

          this.#pending.delete(seqnum);
          pending.resolve({ status, actualLength, data });
        } else if (command === USBIP_RET_UNLINK) {
          const unlink = this.#unlinks.get(seqnum);

          if (!unlink) {
            throw new Error(`RET_UNLINK for unknown seqnum ${seqnum}`);
          }

          this.#unlinks.delete(seqnum);

          // If the unlink won the race, no RET_SUBMIT follows; complete the URB here.
          const submit = this.#pending.get(unlink.submitSeqnum);

          if (status === -ECONNRESET && submit) {
            this.#pending.delete(unlink.submitSeqnum);
            submit.resolve({ status, actualLength: 0, data: Buffer.alloc(0) });
          }

          unlink.resolve(status);
        } else {
          throw new Error(`unexpected USB/IP command ${command}`);
        }
      }
    } catch (error) {
      for (const { reject } of [...this.#pending.values(), ...this.#unlinks.values()]) {
        reject(error);
      }

      this.#pending.clear();
      this.#unlinks.clear();

      if (!this.#closing) {
        throw error;
      }
    }
  }

  #nextSeqnum() {
    this.#seqnum = (this.#seqnum + 1) >>> 0 || 1;

    return this.#seqnum;
  }

  /**
   * USBIP_CMD_SUBMIT for a control/bulk/interrupt URB. `endpoint` is the endpoint number (no direction bit).
   * usbipd-win infers bulk vs. interrupt from `interval` (0 = bulk).
   */
  submit({ endpoint, directionIn, setup, data, length = 0, interval = 0 }) {
    const seqnum = this.#nextSeqnum();
    const header = Buffer.alloc(USBIP_HEADER_SIZE);

    header.writeUInt32BE(USBIP_CMD_SUBMIT, 0);
    header.writeUInt32BE(seqnum, 4);
    header.writeUInt32BE(this.devid, 8);
    header.writeUInt32BE(directionIn ? USBIP_DIR_IN : USBIP_DIR_OUT, 12);
    header.writeUInt32BE(endpoint, 16);
    header.writeUInt32BE(0, 20); // transfer_flags: short reads OK
    header.writeInt32BE(directionIn ? length : (data?.length ?? 0), 24);
    header.writeInt32BE(0, 28); // start_frame
    header.writeInt32BE(0, 32); // number_of_packets: 0 for non-ISO (as Linux does)
    header.writeInt32BE(interval, 36);
    setup?.copy(header, 40);

    const result = new Promise((resolve, reject) => this.#pending.set(seqnum, { directionIn, resolve, reject }));

    this.#socket.write(!directionIn && data?.length ? Buffer.concat([header, data]) : header);

    return { seqnum, result };
  }

  unlink(submitSeqnum) {
    const seqnum = this.#nextSeqnum();
    const header = Buffer.alloc(USBIP_HEADER_SIZE);

    header.writeUInt32BE(USBIP_CMD_UNLINK, 0);
    header.writeUInt32BE(seqnum, 4);
    header.writeUInt32BE(this.devid, 8);
    header.writeUInt32BE(submitSeqnum, 20);

    const result = new Promise((resolve, reject) => this.#unlinks.set(seqnum, { submitSeqnum, resolve, reject }));

    this.#socket.write(header);

    return result;
  }

  /** Submits a URB and unlinks it if it does not complete in time (status becomes -ETIMEDOUT). */
  async transfer(options, timeoutMs) {
    const { seqnum, result } = this.submit(options);

    if (!timeoutMs) {
      return result;
    }

    let timer;
    const timedOut = Symbol('timeout');
    const winner = await Promise.race([
      result,
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs, timedOut);
      })
    ]);

    clearTimeout(timer);

    if (winner !== timedOut) {
      return winner;
    }

    await this.unlink(seqnum);

    const final = await result;

    return final.status === -ECONNRESET ? { ...final, status: -ETIMEDOUT } : final;
  }

  async controlIn(requestType, request, value, index, length) {
    const setup = Buffer.alloc(8);

    setup.writeUInt8(requestType | 0x80, 0);
    setup.writeUInt8(request, 1);
    setup.writeUInt16LE(value, 2);
    setup.writeUInt16LE(index, 4);
    setup.writeUInt16LE(length, 6);

    const { status, data } = await this.transfer({ endpoint: 0, directionIn: true, setup, length }, CONTROL_TIMEOUT_MS);

    if (status !== 0) {
      throw new UsbError(`control IN ${hexByte(request)} ${hexId(value)}`, status);
    }

    return data;
  }

  async controlOut(requestType, request, value, index) {
    const setup = Buffer.alloc(8);

    setup.writeUInt8(requestType & 0x7f, 0);
    setup.writeUInt8(request, 1);
    setup.writeUInt16LE(value, 2);
    setup.writeUInt16LE(index, 4);

    const { status } = await this.transfer({ endpoint: 0, directionIn: false, setup }, CONTROL_TIMEOUT_MS);

    if (status !== 0) {
      throw new UsbError(`control OUT ${hexByte(request)} ${hexId(value)}`, status);
    }
  }

  getDescriptor(type, index, length, languageId = 0) {
    return this.controlIn(0x00, 0x06, (type << 8) | index, languageId, length);
  }

  async getString(index, languageId) {
    if (!index) {
      return null;
    }

    const data = await this.getDescriptor(3, index, 255, languageId);

    return data.subarray(2, Math.min(data[0], data.length)).toString('utf16le');
  }

  async bulkWrite(endpoint, data, timeoutMs = BULK_OUT_TIMEOUT_MS) {
    const { status } = await this.transfer({ endpoint: endpoint & 0x0f, directionIn: false, data }, timeoutMs);

    if (status !== 0) {
      throw new UsbError(`bulk OUT ${hexId(endpoint)}`, status);
    }
  }

  /** Disconnecting makes usbipd-win release the device back to Windows. */
  async close() {
    this.#closing = true;
    this.#socket.end();

    await settleWithin(this.closed, 1000);
    this.#socket.destroy();
  }
}

export function parseConfiguration(data) {
  const configuration = { value: data[5], numInterfaces: data[4], interfaces: [] };
  let current = null;

  for (let offset = 0; offset + 2 <= data.length && data[offset] >= 2; offset += data[offset]) {
    const type = data[offset + 1];

    if (type === 4 && offset + 9 <= data.length) {
      current = {
        number: data[offset + 2],
        alternateSetting: data[offset + 3],
        class: data[offset + 5],
        subClass: data[offset + 6],
        protocol: data[offset + 7],
        endpoints: []
      };
      configuration.interfaces.push(current);
    } else if (type === 5 && current && offset + 7 <= data.length) {
      current.endpoints.push({
        address: data[offset + 2],
        attributes: data[offset + 3],
        maxPacketSize: data.readUInt16LE(offset + 4) & 0x7ff,
        interval: data[offset + 6]
      });
    }
  }

  return configuration;
}

const endpointTypeName = endpoint => ['control', 'isochronous', 'bulk', 'interrupt'][endpoint.attributes & 0x03];
const isIn = endpoint => (endpoint.address & 0x80) !== 0;

function findBulkPair(usbInterface) {
  let endpointIn = null;
  let endpointOut = null;

  for (const endpoint of usbInterface.endpoints) {
    if ((endpoint.attributes & 0x03) === 2) {
      if (isIn(endpoint)) {
        endpointIn = endpoint;
      } else {
        endpointOut = endpoint;
      }
    }
  }

  return { endpointIn, endpointOut };
}

async function dumpDevice(usb, log) {
  const descriptor = await usb.getDescriptor(1, 0, 18);
  const { busid, busnum, devnum, speed } = usb.device;

  log(
    `device ${hexId(descriptor.readUInt16LE(8))}:${hexId(descriptor.readUInt16LE(10))} ` +
      `busid=${busid} bus=${busnum} address=${devnum} speed=${SPEED[speed] ?? speed}`
  );

  try {
    const languages = await usb.getDescriptor(3, 0, 255);
    const languageId = languages.length >= 4 ? languages.readUInt16LE(2) : 0x0409;

    log(`  manufacturer: ${await usb.getString(descriptor[14], languageId)}`);
    log(`  product     : ${await usb.getString(descriptor[15], languageId)}`);
    log(`  serial      : ${await usb.getString(descriptor[16], languageId)}`);
  } catch (error) {
    if (!(error instanceof UsbError)) {
      throw error;
    }
  }

  const header = await usb.getDescriptor(2, 0, 9);
  const configuration = parseConfiguration(await usb.getDescriptor(2, 0, header.readUInt16LE(2)));

  log(`  config ${configuration.value}: ${configuration.numInterfaces} interface(s)`);

  for (const usbInterface of configuration.interfaces) {
    log(
      `    interface ${usbInterface.number} alt=${usbInterface.alternateSetting} ` +
        `class=${hexByte(usbInterface.class)}/${hexByte(usbInterface.subClass)}/${hexByte(usbInterface.protocol)}`
    );

    for (const endpoint of usbInterface.endpoints) {
      log(
        `      endpoint ${hexId(endpoint.address)} ${(isIn(endpoint) ? 'IN' : 'OUT').padEnd(3)} ` +
          `${endpointTypeName(endpoint).padEnd(11)} maxPacket=${endpoint.maxPacketSize}`
      );
    }
  }

  return configuration;
}

function parseInteger(value) {
  const number = /^0x/i.test(value.trim()) ? parseInt(value.trim().slice(2), 16) : Number(value);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`invalid integer: ${value}`);
  }

  return number;
}

function parseNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`invalid number: ${value}`);
  }

  return number;
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: String(USBIP_PORT) },
      busid: { type: 'string' },
      vid: { type: 'string' },
      pid: { type: 'string' },
      interface: { type: 'string' },
      interval: { type: 'string' },
      'no-show': { type: 'boolean', default: false },
      duration: { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });

  return {
    host: values.host,
    port: parseInteger(values.port),
    busid: values.busid,
    vid: values.vid === undefined ? DEFAULT_VID : parseInteger(values.vid),
    pid: values.pid === undefined ? DEFAULT_PID : parseInteger(values.pid),
    interface: values.interface === undefined ? null : parseInteger(values.interface),
    interval: values.interval === undefined ? DEFAULT_INTERVAL : parseNumber(values.interval),
    noShow: values['no-show'],
    duration: values.duration === undefined ? 0 : parseNumber(values.duration),
    list: values.list,
    help: values.help
  };
}

async function usage() {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL(import.meta.url), 'utf8');

  return source.slice(source.indexOf('/*') + 2, source.indexOf('*/')).trim();
}

export async function main(argv = process.argv.slice(2)) {
  const log = message => console.log(message);
  let options;

  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error('run with --help for usage');

    return 2;
  }

  if (options.help) {
    log(await usage());

    return 0;
  }

  const { host, port } = options;
  let busid = options.busid;

  try {
    if (!busid || options.list) {
      const devices = await listDevices(host, port);

      if (options.list) {
        log(`${devices.length} device(s) exported by usbipd-win at ${host}:${port}`);

        for (const device of devices) {
          const interfaces = device.interfaces
            .map(i => `${hexByte(i.class)}/${hexByte(i.subClass)}/${hexByte(i.protocol)}`)
            .join(' ');

          log(
            `  ${device.busid.padEnd(8)} ${hexId(device.idVendor)}:${hexId(device.idProduct)} ` +
              `speed=${SPEED[device.speed] ?? device.speed} interfaces=[${interfaces}]  ${device.path}`
          );
        }

        return 0;
      }

      const matches = devices.filter(d => d.idVendor === options.vid && d.idProduct === options.pid);

      if (!matches.length) {
        console.error(
          `device ${hexId(options.vid)}:${hexId(options.pid)} not exported by usbipd-win at ${host}:${port}\n` +
            '(is the monitor connected and shared? from an elevated prompt run `usbipd list`, ' +
            'then `usbipd bind --busid <BUSID>`)'
        );

        return 1;
      }

      if (matches.length > 1) {
        log(`warning: ${matches.length} matching devices; using busid ${matches[0].busid} (see --busid)`);
      }

      busid = matches[0].busid;
    }
  } catch (error) {
    console.error(error.message);

    return 1;
  }

  let usb;

  try {
    usb = await UsbipDevice.import(host, port, busid);
  } catch (error) {
    console.error(error.message);

    return 1;
  }

  const abort = new AbortController();
  let disconnected = null;

  usb.closed.catch(error => {
    disconnected = error;
    abort.abort();
  });

  const onSigint = () => {
    if (abort.signal.aborted) {
      process.exit(130);
    }

    abort.abort();
  };

  process.on('SIGINT', onSigint);

  try {
    return await run(usb, options, abort.signal, log, () => disconnected);
  } finally {
    process.off('SIGINT', onSigint);
    await usb.close();
  }
}

async function run(usb, options, signal, log, getDisconnected) {
  let configuration;

  try {
    configuration = await dumpDevice(usb, log);
  } catch (error) {
    console.error(error.message);

    return 1;
  }

  const candidates =
    options.interface === null
      ? configuration.interfaces
      : configuration.interfaces.filter(i => i.number === options.interface && i.alternateSetting === 0);

  let chosen = null;

  for (const candidate of candidates) {
    const { endpointIn, endpointOut } = findBulkPair(candidate);

    if (endpointIn && endpointOut) {
      chosen = { usbInterface: candidate, endpointIn, endpointOut };
      break;
    }
  }

  if (!chosen) {
    console.error('no interface with a bulk IN/OUT pair found; run with --interface to try a specific one');

    return 1;
  }

  const { usbInterface, endpointIn, endpointOut } = chosen;

  log('');
  log(
    `using interface ${usbInterface.number} ` +
      `(bulk OUT ${hexId(endpointOut.address)}, bulk IN ${hexId(endpointIn.address)})`
  );

  try {
    // Like a USB/IP host stack, select the configuration; usbipd-win needs it to open the endpoint pipes.
    await usb.controlOut(0x00, 0x09, configuration.value, 0);

    if (usbInterface.alternateSetting !== 0) {
      await usb.controlOut(0x01, 0x0b, usbInterface.alternateSetting, usbInterface.number);
    }
  } catch (error) {
    console.error(error.message);

    return 1;
  }

  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const expired = () => options.duration > 0 && elapsed() >= options.duration;
  let stopping = false;
  let pendingRead = null;

  const reader = (async () => {
    const size = endpointIn.maxPacketSize || 64;

    while (!stopping) {
      const { seqnum, result } = usb.submit({ endpoint: endpointIn.address & 0x0f, directionIn: true, length: size });
      let reply;

      pendingRead = seqnum;

      try {
        reply = await result;
      } catch (error) {
        if (!stopping) {
          log(`RX error: ${error.message}`);
        }

        return;
      } finally {
        pendingRead = null;
      }

      if (reply.status !== 0) {
        if (!stopping) {
          log(`RX error: ${errnoName(reply.status)}`);
        }

        return;
      }

      const text = reply.data.toString('utf8').trim();

      log(`[${elapsed().toFixed(2).padStart(6)}s] RX ${formatBytes(reply.data)}  ->  ${quote(text)}`);

      for (const line of text.replaceAll('\r', '\n').split('\n')) {
        if (line === 'flip') {
          log('   [FLIP button pressed]');
        }
      }
    }
  })();

  const sleep = ms => delay(ms, undefined, { signal }).catch(() => {});

  try {
    if (options.noShow) {
      log('listening; Ctrl-C to exit');
    } else {
      log(`sending 'show' every ${options.interval}s; Ctrl-C to send 'stop'`);
    }

    const tick = options.noShow ? 100 : options.interval * 1000;

    while (!expired() && !signal.aborted) {
      if (!options.noShow) {
        await usb.bulkWrite(endpointOut.address, Buffer.from('show'));
      }

      await sleep(options.duration > 0 ? Math.min(tick, (options.duration - elapsed()) * 1000) : tick);
    }

    if (getDisconnected()) {
      log(`device disconnected: ${getDisconnected().message}`);
    } else if (signal.aborted) {
      log('\ninterrupted');
    } else if (options.duration > 0) {
      log(`duration reached (${options.duration}s)`);
    }
  } catch (error) {
    console.error(`TX error: ${error.message}`);
  } finally {
    if (!getDisconnected()) {
      try {
        log("TX b'stop'");
        await usb.bulkWrite(endpointOut.address, Buffer.from('stop'));
        await delay(300);
      } catch {
        // Best effort, like the other probes.
      }
    }

    stopping = true;

    if (pendingRead !== null) {
      await settleWithin(usb.unlink(pendingRead), 1000);
    }

    await settleWithin(reader, 1000);
  }

  return getDisconnected() ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
