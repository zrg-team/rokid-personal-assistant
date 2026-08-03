import { WAKE_WORD, BUILD, CONNECTIONS } from './config.js';

export default {
  onLaunch() {
    // Logged first and on its own line so it survives log truncation.
    console.log('[people-memory] build ' + BUILD);
    console.log(
      '[people-memory] launch — wake=' + WAKE_WORD +
      ' connections=' + CONNECTIONS.map((c) => c.slug).join(',')
    );
  },

  onShow() {
    console.log('[people-memory] show');
  },

  onHide() {
    console.log('[people-memory] hide');
  },

  onError(error) {
    console.error('[people-memory] error', error);
  },

  globalData: {
    lastTurn: null,
  },
};
