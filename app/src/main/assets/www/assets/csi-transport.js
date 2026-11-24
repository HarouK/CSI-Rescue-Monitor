/* CSI Rescue Monitor - WebSocket transport with connect timeout and auto-reconnect.
 * Knows nothing about the UI or message contents. Delivers raw text frames. */
(function (root) {
  'use strict';

  function Transport(opts) {
    opts = opts || {};
    this.WS = opts.WebSocket || root.WebSocket;
    this.setT = opts.setTimeout || setTimeout.bind(root);
    this.clearT = opts.clearTimeout || clearTimeout.bind(root);
    this.now = opts.now || Date.now;
    this.random = opts.random || Math.random;
    this.connectTimeoutMs = opts.connectTimeoutMs || 6000;
    this.baseDelayMs = opts.baseDelayMs || 1000;
    this.maxDelayMs = opts.maxDelayMs || 15000;
    this.onState = opts.onState || function () {};
    this.onFrame = opts.onFrame || function () {};
    this.url = null; this.state = 'idle'; this.attempt = 0; this.nextRetryAt = null;
    this.lastError = null; this.gen = 0; this.sock = null; this.timer = null; this.wanted = false;
  }

  Transport.prototype._set = function (state, extra) {
    this.state = state;
    this.onState(state, Object.assign({ attempt: this.attempt, nextRetryAt: this.nextRetryAt, error: this.lastError, url: this.url }, extra || {}));
  };

  Transport.prototype.connect = function (url) {
    this._teardown();
    this.url = url; this.wanted = true; this.attempt = 0; this.lastError = null;
    this._open();
  };

  Transport.prototype.disconnect = function () {
    this.wanted = false;
    this._teardown();
    this.nextRetryAt = null; this.attempt = 0;
    this._set('idle');
  };

  Transport.prototype.retryNow = function () {
    if (!this.wanted || this.state === 'connecting' || this.state === 'open') return;
    this._clearTimer(); this._open();
  };

  Transport.prototype._clearTimer = function () { if (this.timer) { this.clearT(this.timer); this.timer = null; } };

  Transport.prototype._teardown = function () {
    this.gen++; this._clearTimer();
    var s = this.sock; this.sock = null;
    if (s) { s.onopen = s.onmessage = s.onerror = s.onclose = null; try { s.close(); } catch (e) { /* ignore */ } }
  };

  Transport.prototype._open = function () {
    var self = this, gen = ++this.gen;
    this.nextRetryAt = null;
    this._set('connecting');
    var s;
    try { if (!this.WS) throw new Error('WebSocket not supported'); s = new this.WS(this.url); }
    catch (e) { this.lastError = 'Cannot open socket: ' + (e && e.message ? e.message : e); this._lost(gen); return; }
    this.sock = s;
    this.timer = this.setT(function () {
      if (gen !== self.gen) return;
      self.lastError = 'Connection timed out (no response from gateway)';
      self._lost(gen);
    }, this.connectTimeoutMs);
    s.onopen = function () {
      if (gen !== self.gen) return;
      self._clearTimer(); self.attempt = 0; self.lastError = null; self._set('open');
    };
    s.onmessage = function (ev) { if (gen === self.gen) self.onFrame(ev.data); };
    s.onerror = function () { if (gen === self.gen && !self.lastError) self.lastError = 'Socket error (gateway unreachable or refused)'; };
    s.onclose = function (ev) {
      if (gen !== self.gen) return;
      if (!self.lastError) self.lastError = 'Connection closed' + (ev && ev.code ? ' (code ' + ev.code + ')' : '');
      self._lost(gen);
    };
  };

  Transport.prototype._lost = function (gen) {
    if (gen !== this.gen) return;
    var s = this.sock; this.sock = null; this._clearTimer();
    if (s) { s.onopen = s.onmessage = s.onerror = s.onclose = null; try { s.close(); } catch (e) { /* ignore */ } }
    if (!this.wanted) { this._set('idle'); return; }
    this.attempt++;
    var d = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, this.attempt - 1));
    d = Math.round(d * (0.85 + 0.3 * this.random()));
    this.nextRetryAt = this.now() + d;
    this._set('reconnecting');
    var self = this, g = this.gen;
    this.timer = this.setT(function () { if (g === self.gen && self.wanted) { self.timer = null; self._open(); } }, d);
  };

  var api = { Transport: Transport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CSI = root.CSI || {}; root.CSI.Transport = Transport; }
})(typeof window !== 'undefined' ? window : globalThis);
