/*
 * Standalone host bridge for games exported as YouTube Playables.
 *
 * The original packages wait for APIs supplied only by the YouTube app, which
 * leaves them on a blank/loading screen when hosted in a normal arcade. This
 * bridge supplies local equivalents for saves, sound, scores, and ad requests.
 */
(function setupStandalonePlayableHost() {
  "use strict";

  const prefix = "1117-playable:";
  const listeners = new Map();
  const safely = (task, fallback) => {
    try {
      return task();
    } catch {
      return fallback;
    }
  };
  const noOp = () => undefined;
  const noOpAsync = async () => undefined;
  const localGet = (key, fallback = null) => safely(() => localStorage.getItem(prefix + key) ?? fallback, fallback);
  const localSet = (key, value) => safely(() => localStorage.setItem(prefix + key, value), undefined);
  const createApi = (api) =>
    new Proxy(api, {
      get(target, property) {
        return property in target ? target[property] : noOpAsync;
      },
    });

  const on = (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => listeners.get(event)?.delete(callback);
  };
  const off = (event, callback) => listeners.get(event)?.delete(callback);

  const scoreModule = createApi({
    async getBestScore() {
      return Number(localGet("best-score", "0")) || 0;
    },
    async setBestScore(score) {
      localSet("best-score", String(Number(score) || 0));
    },
  });
  const storeModule = createApi({
    async get(keys) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : []).map((key) => {
          const stored = localGet(`store:${key}`);
          if (stored === null) return [key, null];
          try {
            return [key, JSON.parse(stored)];
          } catch {
            return [key, stored];
          }
        }),
      );
    },
    async save(key, value) {
      localSet(`store:${key}`, JSON.stringify(value));
    },
  });

  const H5SDK = createApi({
    addEventListener: on,
    removeEventListener: off,
    getPlatform: () =>
      createApi({
        async init() {},
        async notifyLoadingComplete() {},
        async notifyLevelEnd() {},
        getPlayerInfo: () => ({
          playerName: "Player",
          playerPic:
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        }),
        isAudioEnabled: () => true,
      }),
    getConfigModule: () => createApi({ set: noOp }),
    getStoreModule: () => storeModule,
    getScoreModule: () => scoreModule,
    getProfileModule: () => createApi({ async getProfiles() { return []; } }),
    getAdsModule: () =>
      createApi({
        async requestRewardedAd() {
          return false;
        },
        async requestInterstitialAd() {
          return false;
        },
      }),
    getFriendsModule: () => createApi({ async inviteFriends() {}, async shareWithFriends() {} }),
  });

  class SecuredVariable {
    constructor(value = 0) {
      this.value = value;
    }
    set(value) {
      this.value = value;
    }
    setRaw(value) {
      this.value = value;
    }
    get() {
      return this.value;
    }
    isSecuredValue() {
      return false;
    }
  }

  window.H5SDK = H5SDK;
  window.SecuredVariable = window.SecuredVariable || SecuredVariable;
  window.ytgame = createApi({
    game: createApi({
      firstFrameReady: noOp,
      gameReady: noOp,
      async loadData() {
        return localGet("game-data", "");
      },
      async saveData(value) {
        localSet("game-data", value);
      },
    }),
    system: createApi({
      async getLanguage() {
        return (navigator.language || "en").slice(0, 2);
      },
      isAudioEnabled: () => true,
      onAudioEnabledChange: () => noOp,
      onPause: () => noOp,
      onResume: () => noOp,
    }),
    engagement: createApi({ sendScore: noOp }),
    health: createApi({ logError: noOp }),
    ads: createApi({ async requestRewardedAd() { return false; }, async requestInterstitialAd() { return false; } }),
  });
})();
