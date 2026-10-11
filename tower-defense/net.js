// Multiplayer rooms over WebRTC data channels (PeerJS). One browser is the host and owns the
// game; guests connect straight to it and exchange small messages. PeerJS's free cloud server
// only introduces browsers to each other; game traffic is peer to peer.
//
// A room survives its host: if the host drops out, another player takes over under the same
// room code at the next "epoch" (peer id CODE-1, CODE-2, ...). Joining checks every epoch and
// connects to the newest one, so the original link keeps working.

const PREFIX = 'keydefense-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, which look like 1/0
const MAX_EPOCH = 8;
export const MAX_PLAYERS = 4;

export const makeCode = () =>
  Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const roomPeerId = (code, epoch = 0) => PREFIX + code + (epoch ? `-${epoch}` : '');

function PeerClass() {
  if (!window.Peer) throw new Error('The multiplayer library did not load. Check your internet connection.');
  return window.Peer;
}

const waitOpen = peer => new Promise((resolve, reject) => {
  if (peer.open) return resolve();
  peer.once('open', () => resolve());
  peer.once('error', reject);
});

export class Room {
  // handlers: onMessage(msg, from), onLeave(peerId), onHostLeft(), onError(err), onSignal(online)
  constructor(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conns = new Map(); // host: guest peer id -> connection
    this.hostConn = null;   // guest: connection to the host
    this.code = null;
    this.epoch = 0;
  }

  _watch(peer) {
    peer.on('disconnected', () => {
      // lost the signalling server (network blip); open data channels may still work
      this.h.onSignal?.(false);
      if (!peer.destroyed) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
    });
    peer.on('open', () => this.h.onSignal?.(true));
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') return; // a room id we probed doesn't exist; handled by timeouts
      if (this._settled) this.h.onError?.(err);
    });
  }

  // Host a new room (random code), or take over an existing code at a given epoch.
  host(code = null, epoch = 0) {
    const Peer = PeerClass();
    this.close();
    return new Promise((resolve, reject) => {
      const attempt = n => {
        const c = code ?? makeCode();
        const peer = new Peer(roomPeerId(c, epoch));
        const onErr = err => {
          peer.off('open', onOpen);
          if (err.type === 'unavailable-id' && !code && n < 5) {
            peer.destroy();
            attempt(n + 1); // random code already in use somewhere: pick another
          } else {
            peer.destroy();
            reject(err.type === 'unavailable-id' ? new Error('That room id is still taken.') : err);
          }
        };
        const onOpen = () => {
          peer.off('error', onErr);
          this.peer = peer;
          this.code = c;
          this.epoch = epoch;
          this._settled = true;
          this._watch(peer);
          peer.on('connection', conn => this._accept(conn));
          resolve(c);
        };
        peer.once('open', onOpen);
        peer.once('error', onErr);
      };
      attempt(0);
    });
  }

  _accept(conn) {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      conn.on('data', msg => this.h.onMessage?.(msg, conn.peer));
      conn.on('close', () => {
        if (this.conns.get(conn.peer) !== conn) return;
        this.conns.delete(conn.peer);
        this.h.onLeave?.(conn.peer);
      });
    });
  }

  async _guestPeer() {
    if (!this.peer || this.peer.destroyed) {
      this.peer = new (PeerClass())();
      this._watch(this.peer);
    }
    if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
    await waitOpen(this.peer);
    return this.peer;
  }

  _wireHost(conn, epoch) {
    this.hostConn = conn;
    this.epoch = epoch;
    conn.on('data', msg => this.h.onMessage?.(msg, 'host'));
    conn.on('close', () => {
      if (this.hostConn !== conn) return;
      this.hostConn = null;
      this.h.onHostLeft?.();
    });
  }

  // Try to open a connection to one room id; resolves with the connection or null after timeout.
  async _probe(code, epoch, timeoutMs) {
    const peer = await this._guestPeer();
    const id = roomPeerId(code, epoch);
    return new Promise(resolve => {
      const conn = peer.connect(id, { reliable: true });
      const done = result => {
        clearTimeout(timer);
        peer.off('error', onPeerErr);
        resolve(result);
      };
      // PeerJS reports a missing id on the peer, not the connection; match it by id
      const onPeerErr = err => {
        if (err.type === 'peer-unavailable' && String(err.message).endsWith(id)) { conn.close(); done(null); }
      };
      const timer = setTimeout(() => { conn.close(); done(null); }, timeoutMs);
      peer.on('error', onPeerErr);
      conn.on('open', () => done(conn));
      conn.on('error', () => done(null));
    });
  }

  // Join a room by code: probe every epoch at once and keep the newest one that answers.
  async join(code) {
    code = code.trim().toUpperCase();
    this._settled = false;
    try {
      await this._guestPeer();
    } catch (err) {
      throw new Error(`Couldn't reach the multiplayer server: ${err.message || err.type}`);
    }
    const found = await Promise.all(Array.from({ length: MAX_EPOCH + 1 }, (_, e) => this._probe(code, e, 6000).then(conn => ({ conn, e }))));
    const open = found.filter(f => f.conn);
    if (!open.length) throw new Error(`No room with code ${code} (or it has closed).`);
    const best = open.reduce((a, b) => (b.e > a.e ? b : a));
    for (const f of open) if (f !== best) f.conn.close();
    this.code = code;
    this._settled = true;
    this._wireHost(best.conn, best.e);
    return best.e;
  }

  // Reconnect to a specific epoch of this room (used after losing the host).
  async connectTo(epoch, timeoutMs) {
    const conn = await this._probe(this.code, epoch, timeoutMs);
    if (!conn) return false;
    this._wireHost(conn, epoch);
    return true;
  }

  // Is there a newer epoch of this room than ours? (a returning host checks this)
  async findNewer() {
    const tries = await Promise.all(
      Array.from({ length: MAX_EPOCH - this.epoch }, (_, i) => this.epoch + 1 + i)
        .map(e => this._probe(this.code, e, 5000).then(conn => ({ conn, e }))),
    );
    const open = tries.filter(t => t.conn);
    for (const t of open) t.conn.close();
    return open.length ? Math.max(...open.map(t => t.e)) : null;
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
    this.hostConn = null;
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}
