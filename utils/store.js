/**
 * Small persistence layer for the last good calendar result.
 *
 * The glasses store through the `wx` module (`wx.getStorageSync` /
 * `wx.setStorageSync` — the verified AIUI storage API; `localStorage` is not in
 * the confirmed runtime surface). `wx` is import-only, so it cannot be imported
 * here without breaking the browser dev harness. The backend is injected
 * instead, which keeps this file platform-free and shared by both.
 *
 *   pages/*.ink  ->  createStore(wxBackend(wx))
 *   dev harness  ->  createStore(webBackend(window.localStorage))
 */

/** Backend over the AIUI `wx` module. */
export function wxBackend(wx) {
  return {
    get(key) {
      try {
        return wx.getStorageSync(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        wx.setStorageSync(key, value);
      } catch (e) {
        /* storage full or unavailable — the cache is an optimization only */
      }
    },
  };
}

/** Backend over a Web Storage object, for the dev harness. */
export function webBackend(storage) {
  return {
    get(key) {
      try {
        return storage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        storage.setItem(key, value);
      } catch (e) {
        /* ignore */
      }
    },
  };
}

/** Last-resort backend so a missing platform never breaks a page. */
export function memoryBackend() {
  const map = {};
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },
    set(key, value) {
      map[key] = value;
    },
  };
}

export function createStore(backend) {
  const io = backend || memoryBackend();

  return {
    /** @returns {object|null} the stored record, or null when absent/corrupt */
    read(key) {
      const raw = io.get(key);
      if (raw === null || raw === undefined || raw === '') return null;

      // wx.setStorageSync may JSON-serialize on the way in, so a read can come
      // back as either the original string or an already-revived object.
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },

    write(key, value) {
      try {
        io.set(key, JSON.stringify(value));
      } catch (e) {
        /* unserializable value — skip the cache rather than throw */
      }
    },
  };
}
