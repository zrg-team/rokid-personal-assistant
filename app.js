import { composioConfig, WAKE_WORD, BUILD } from './config.js';

export default {
  onLaunch() {
    // Logged first and on its own line so it survives log truncation.
    console.log('[people-memory] build ' + BUILD);
    console.log(
      '[people-memory] launch — transport=' + composioConfig.transport +
      ' wake=' + WAKE_WORD +
      ' toolkits=' + composioConfig.toolkits.join(',')
    );

    if (composioConfig.transport === 'mcp' && !composioConfig.mcpUrl) {
      console.warn('[people-memory] transport is "mcp" but mcpUrl is empty — falling back to REST');
    }
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
