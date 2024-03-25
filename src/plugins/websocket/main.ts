import { createServer, type Server } from 'node:http';
import { type Socket } from 'node:net';
import { type Duplex as StreamDuplex } from 'node:stream';
import { createHash } from 'node:crypto';

import { app, ipcMain, IpcMainEvent } from 'electron';
import { dev } from 'electron-is';

import { createBackend, LoggerPrefix } from '@/utils';
import registerCallback, { type SongInfo } from '@/providers/song-info';

import type { WebsocketPluginConfig } from './index';

let window: Electron.BrowserWindow;

export interface State {
  ready: boolean;
  httpServer?: Server;
  httpSockets: {
    [id: number]: Socket;
  };
  wsSockets: {
    [id: string]: StreamDuplex;
  };
  nextSocketId: number;
  lastSongInfo?: SongInfo;
}

const state: State = {
  ready: false,
  httpServer: undefined,
  httpSockets: {},
  wsSockets: {},
  nextSocketId: 0,
  lastSongInfo: undefined,
};

function devLog(...args: unknown[]) {
  if (dev()) {
    console.log(LoggerPrefix, ...args);
  }
}

export const backend = createBackend<
  {
    config?: WebsocketPluginConfig;
    updateActivity: (songInfo: SongInfo, config: WebsocketPluginConfig) => void;
  },
  WebsocketPluginConfig
>({
  async start({ window: win, getConfig }) {
    this.config = await getConfig();
    window = win;

    state.httpServer = createServer((_req, res) => {
      // send state.lastSongInfo as JSON
      const json = JSON.stringify({
        songInfo: state.lastSongInfo,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
    }).listen(23232, () => {
      devLog('WebSocket HTTP Server listening on port 23232');
      state.ready = true;
    });

    state.httpServer.on('connection', (socket) => {
      const id = state.nextSocketId++;
      state.httpSockets[id] = socket;
      devLog('New HTTP connection', id);

      // Remove the socket when it closes
      socket.on('close', () => {
        devLog('HTTP connection closed', id);
        delete state.httpSockets[id];
      });
    });

    state.httpServer.on('upgrade', (req, socket, _head) => {
      const id = state.nextSocketId++;
      state.wsSockets[id] = socket;
      devLog('New WebSocket upgrade', id);

      const key =
        req.headers['sec-websocket-key']?.trim() +
        '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
      // Calculate the SHA-1 hash of the key
      const sha1 = createHash('sha1');
      sha1.update(key);
      const responseKey = sha1.digest('base64');

      socket.write(
        'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
        'Upgrade: WebSocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + responseKey + '\r\n' +
        '\r\n',
      );

      socket.on('data', () => {
        devLog('Got WebSocket client data');
      });

      socket.on('end', () => {
        devLog('WebSocket client disconnected', id);
        delete state.wsSockets[id];
      });

      // Send state.lastSongInfo to the new client
      socket.write(
        constructReply({
          songInfo: state.lastSongInfo,
        }),
      );
    });

    win.once('ready-to-show', () => {
      let lastSongInfo: SongInfo;
      registerCallback((songInfo) => {
        lastSongInfo = songInfo;
        if (this.config) this.updateActivity(songInfo, this.config);
      });
      // connect();
      let lastSent = Date.now();
      ipcMain.on('ytmd:time-changed', (_: IpcMainEvent, t: number) => {
        const currentTime = Date.now();
        devLog('ytmd:time-changed', t, currentTime, currentTime - lastSent);
        // if lastSent is more than 5 seconds ago, send the new time
        if (currentTime - lastSent > 5000) {
          lastSent = currentTime;
          if (lastSongInfo) {
            lastSongInfo.elapsedSeconds = t;
            if (this.config) this.updateActivity(lastSongInfo, this.config);
          }
        }
      });
    });
  },
  stop() {
    if (state.httpServer) {
      state.httpServer.close();
      // Destroy all open sockets
      Object.values(state.wsSockets).forEach((socket) => socket.destroy());
      Object.values(state.httpSockets).forEach((socket) => socket.destroy());
      devLog('WebSocket HTTP Server closed');
    }
  },
  onConfigChange(newConfig) {
    this.config = newConfig;
    // info.autoReconnect = newConfig.autoReconnect;
    if (state.lastSongInfo) {
      this.updateActivity(state.lastSongInfo, newConfig);
    }
  },
  updateActivity: (songInfo) => {
    if (songInfo.title.length === 0 && songInfo.artist.length === 0) {
      return;
    }

    state.lastSongInfo = songInfo;

    // Stop early if not ready
    if (!state.ready) {
      return;
    }

    // Song information changed, so broadcast it
    const hangulFillerUnicodeCharacter = '\u3164'; // This is an empty character
    if (songInfo.title.length < 2) {
      songInfo.title += hangulFillerUnicodeCharacter.repeat(
        2 - songInfo.title.length,
      );
    }
    if (songInfo.artist.length < 2) {
      songInfo.artist += hangulFillerUnicodeCharacter.repeat(
        2 - songInfo.title.length,
      );
    }

    // send state.lastSongInfo to all connected clients
    Object.values(state.wsSockets).forEach((socket) =>
      socket.write(
        constructReply({
          songInfo: state.lastSongInfo,
        }),
      )
    );
  },
});

// https://medium.com/hackernoon/implementing-a-websocket-server-with-node-js-d9b78ec5ffa8
function constructReply(data: object) {
  // Convert the data to JSON and copy it into a buffer
  const json = JSON.stringify(data);
  const jsonByteLength = Buffer.byteLength(json);
  // Note: we're not supporting > 65535 byte payloads at this stage
  const lengthByteCount = jsonByteLength < 126 ? 0 : 2;
  const payloadLength = lengthByteCount === 0 ? jsonByteLength : 126;
  const buffer = Buffer.alloc(2 + lengthByteCount + jsonByteLength);
  // Write out the first byte, using opcode `1` to indicate that the message
  // payload contains text data
  buffer.writeUInt8(0b10000001, 0);
  buffer.writeUInt8(payloadLength, 1);
  // Write the length of the JSON payload to the second byte
  let payloadOffset = 2;
  if (lengthByteCount > 0) {
    buffer.writeUInt16BE(jsonByteLength, 2);
    payloadOffset += lengthByteCount;
  }
  // Write the JSON data to the data buffer
  buffer.write(json, payloadOffset);
  return buffer;
}