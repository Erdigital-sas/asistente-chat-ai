// state.js
const runtimeStats = {
  startedAt: Date.now(),
  http: {
    total: 0,
    ok: 0,
    error: 0,
    lastMs: 0
  },
  suggestions: {
    total: 0,
    ok: 0,
    error: 0,
    inflightHits: 0,
    secondPasses: 0,
    lastMs: 0
  },
  translations: {
    total: 0,
    ok: 0,
    error: 0,
    cacheHits: 0,
    inflightHits: 0,
    lastMs: 0
  },
  warnings: {
    total: 0,
    ok: 0,
    error: 0,
    rowsUpserted: 0,
    lastMs: 0
  },
  openai: {
    total: 0,
    ok: 0,
    error: 0,
    suggestionCalls: 0,
    translationCalls: 0,
    lastMs: 0
  },
  admin: {
    loginTotal: 0,
    loginOk: 0,
    loginError: 0,
    operatorList: 0,
    operatorCreate: 0,
    operatorUpdate: 0,
    operatorDelete: 0,
    dashboardLoads: 0
  }
};

const operatorAuthCache = new Map();
const translationCache = new Map();
const inflightTranslationJobs = new Map();
const inflightSuggestionJobs = new Map();
const adminLoginAttempts = new Map();
const operatorSuggestionQueues = new Map();

module.exports = {
  runtimeStats,
  operatorAuthCache,
  translationCache,
  inflightTranslationJobs,
  inflightSuggestionJobs,
  adminLoginAttempts,
  operatorSuggestionQueues
};