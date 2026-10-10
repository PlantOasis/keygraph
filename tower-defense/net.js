// Multiplayer rooms over WebRTC data channels (PeerJS). The host's browser owns the game:
// guests connect straight to the host and exchange small JSON messages. PeerJS's free cloud
// server is only used to introduce the browsers to each other; game traffic is peer to peer.

const PREFIX = 'keydefense-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, which look like 1/0
export const MAX_PLAYERS = 4;

export const makeCode = () =>
  Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

function PeerClass() {
  if (!window.Peer) throw new Error('The multiplayer library did not load. Check your internet connection.');
  return window.Peer;
}

export class Room {
  // handlers: onMessage(msg, fromPeerId), onLeave(peerId), onHostLeft(), onError(err), canJoin() -> reason|null
  constructor(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conns = new Map(); // host: guest peer id -> connection
    this.hostConn = null;   // guest: connection to the host
    this.code = null;
  }

  host() {
    const Peer = PeerClass();
    return new Promise((resolve, reject) => {
      const attempt = n => {
        const code = makeCode();
        const peer = new Peer(PREFIX + code);
        peer.on('open', () => {
          this.peer = peer;
          this.code = code;
          resolve(code);
        });
        peer.on('error', err => {
          if (err.type === 'unavailable-id' && n < 5) {
            peer.destroy();
            attempt(n + 1); // code already in use somewhere: pick another
          } else if (!this.peer) reject(err);
          else this.h.onError?.(err);
        });
        peer.on('connection', conn => this._accept(conn));
        peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      };
      attempt(0);
    });
  }

  _accept(conn) {
    conn.on('open', () => {
      const reason = this.h.canJoin?.();
      if (reason) {
        conn.send({ t: 'reject', reason });
        setTimeout(() => conn.close(), 500);
        return;
      }
      this.conns.set(conn.peer, conn);
      conn.on('data', msg => this.h.onMessage?.(msg, conn.peer));
      conn.on('close', () => {
        this.conns.delete(conn.peer);
        this.h.onLeave?.(conn.peer);
      });
    });
  }

  join(code) {
    const Peer = PeerClass();
    code = code.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      const peer = (this.peer = new Peer());
      let settled = false;
      const fail = err => {
        if (settled) return this.h.onError?.(err);
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Could not reach that room. Check the code and that the host still has the game open.')), 15000);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true });
        conn.on('open', () => {
          settled = true;
          clearTimeout(timer);
          this.hostConn = conn;
          this.code = code;
          resolve();
        });
        conn.on('data', msg => this.h.onMessage?.(msg, 'host'));
        conn.on('close', () => { if (settled) this.h.onHostLeft?.(); });
      });
      peer.on('error', err => fail(err.type === 'peer-unavailable' ? new Error(`No room with code ${code}.`) : err));
    });
  }

  // guest -> host
  send(msg) {
    if (this.hostConn?.open) this.hostConn.send(msg);
  }

  // host -> every guest (optionally skipping one)
  broadcast(msg, except = null) {
    for (const [id, c] of this.conns) if (id !== except && c.open) c.send(msg);
  }

  sendTo(id, msg) {
    const c = this.conns.get(id);
    if (c?.open) c.send(msg);
  }

  close() {
    this.peer?.destroy();
    this.peer = null;
    this.conns.clear();
    this.hostConn = null;
  }
}
