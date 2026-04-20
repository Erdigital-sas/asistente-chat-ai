// services/openai.js
const {
  API_KEY,
  OPENAI_URL,
  OPENAI_TIMEOUT_SUGGESTIONS_MS,
  OPENAI_TIMEOUT_TRANSLATE_MS,
  SUGGESTION_OPENAI_CONCURRENCY,
  TRANSLATION_OPENAI_CONCURRENCY,
  SUGGESTION_OPENAI_QUEUE_LIMIT,
  TRANSLATION_OPENAI_QUEUE_LIMIT,
  SUGGESTION_OPENAI_QUEUE_WAIT_MS,
  TRANSLATION_OPENAI_QUEUE_WAIT_MS,
  PER_OPERATOR_SUGGESTION_QUEUE_LIMIT,
  PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS
} = require("../config");

const {
  runtimeStats,
  operatorSuggestionQueues
} = require("../state");

const { normalizarTexto } = require("../lib/utils");

class ConcurrencyLimiter {
  constructor({ name, maxConcurrent, maxQueue, waitTimeoutMs }) {
    this.name = name;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.waitTimeoutMs = waitTimeoutMs;
    this.active = 0;
    this.queue = [];
  }

  get activeCount() {
    return this.active;
  }

  get queuedCount() {
    return this.queue.length;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const job = {
        started: false,
        timeoutId: null,
        execute: null
      };

      const execute = () => {
        job.started = true;

        if (job.timeoutId) {
          clearTimeout(job.timeoutId);
          job.timeoutId = null;
        }

        this.active += 1;

        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active = Math.max(0, this.active - 1);
            this.drain();
          });
      };

      job.execute = execute;

      if (this.active < this.maxConcurrent) {
        execute();
        return;
      }

      if (this.queue.length >= this.maxQueue) {
        reject(new Error(`Servidor ocupado. Cola ${this.name} llena`));
        return;
      }

      if (this.waitTimeoutMs > 0) {
        job.timeoutId = setTimeout(() => {
          if (job.started) return;

          const idx = this.queue.indexOf(job);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }

          reject(new Error(`Servidor ocupado. Tiempo de espera agotado en ${this.name}`));
        }, this.waitTimeoutMs);
      }

      this.queue.push(job);
    });
  }

  drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      job.execute();
    }
  }
}

const suggestionsOpenAILimiter = new ConcurrencyLimiter({
  name: "openai_sugerencias",
  maxConcurrent: SUGGESTION_OPENAI_CONCURRENCY,
  maxQueue: SUGGESTION_OPENAI_QUEUE_LIMIT,
  waitTimeoutMs: SUGGESTION_OPENAI_QUEUE_WAIT_MS
});

const translationOpenAILimiter = new ConcurrencyLimiter({
  name: "openai_traduccion",
  maxConcurrent: TRANSLATION_OPENAI_CONCURRENCY,
  maxQueue: TRANSLATION_OPENAI_QUEUE_LIMIT,
  waitTimeoutMs: TRANSLATION_OPENAI_QUEUE_WAIT_MS
});

function countOperatorSuggestionsRunning() {
  let total = 0;

  for (const state of operatorSuggestionQueues.values()) {
    if (state.running) total += 1;
  }

  return total;
}

function countOperatorSuggestionsQueued() {
  let total = 0;

  for (const state of operatorSuggestionQueues.values()) {
    total += state.queue.length;
  }

  return total;
}

function getOrCreateOperatorQueueState(operadorKey) {
  if (!operatorSuggestionQueues.has(operadorKey)) {
    operatorSuggestionQueues.set(operadorKey, {
      running: false,
      queue: [],
      lastUsedAt: Date.now()
    });
  }

  return operatorSuggestionQueues.get(operadorKey);
}

function cleanupOperatorSuggestionQueue(operadorKey, state) {
  if (!state.running && state.queue.length === 0) {
    operatorSuggestionQueues.delete(operadorKey);
  }
}

function drainOperatorSuggestionQueue(operadorKey, state) {
  if (state.running) return;

  const nextJob = state.queue.shift();

  if (!nextJob) {
    cleanupOperatorSuggestionQueue(operadorKey, state);
    return;
  }

  nextJob.execute();
}

function runSuggestionQueueByOperator(operador = "", task) {
  const operadorKey = normalizarTexto(operador || "anon");
  const state = getOrCreateOperatorQueueState(operadorKey);

  return new Promise((resolve, reject) => {
    const job = {
      started: false,
      timeoutId: null,
      execute: null
    };

    const execute = () => {
      job.started = true;
      state.running = true;
      state.lastUsedAt = Date.now();

      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
        job.timeoutId = null;
      }

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.running = false;
          state.lastUsedAt = Date.now();
          drainOperatorSuggestionQueue(operadorKey, state);
        });
    };

    job.execute = execute;

    if (!state.running) {
      execute();
      return;
    }

    if (state.queue.length >= PER_OPERATOR_SUGGESTION_QUEUE_LIMIT) {
      reject(new Error("Este operador ya tiene demasiadas solicitudes de IA en curso"));
      return;
    }

    if (PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS > 0) {
      job.timeoutId = setTimeout(() => {
        if (job.started) return;

        const idx = state.queue.indexOf(job);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
        }

        cleanupOperatorSuggestionQueue(operadorKey, state);
        reject(new Error("La cola de IA de este operador esta llena o lenta"));
      }, PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS);
    }

    state.queue.push(job);
  });
}

function getSharedInFlight(map, key, factory) {
  if (map.has(key)) {
    return {
      shared: true,
      promise: map.get(key)
    };
  }

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (map.get(key) === promise) {
        map.delete(key);
      }
    });

  map.set(key, promise);

  return {
    shared: false,
    promise
  };
}

function obtenerOpenAILimiter(lane = "sugerencias") {
  return lane === "traduccion"
    ? translationOpenAILimiter
    : suggestionsOpenAILimiter;
}

async function llamarOpenAI({
  lane = "sugerencias",
  model,
  messages,
  temperature = 0.58,
  maxTokens = 420,
  timeoutMs
}) {
  const limiter = obtenerOpenAILimiter(lane);
  const timeoutFinal = timeoutMs || (
    lane === "traduccion"
      ? OPENAI_TIMEOUT_TRANSLATE_MS
      : OPENAI_TIMEOUT_SUGGESTIONS_MS
  );

  return limiter.run(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutFinal);
    const startedAt = Date.now();

    runtimeStats.openai.total += 1;
    if (lane === "traduccion") runtimeStats.openai.translationCalls += 1;
    else runtimeStats.openai.suggestionCalls += 1;

    try {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens
        })
      });

      let data;

      try {
        data = await response.json();
      } catch (_err) {
        throw new Error("La respuesta de OpenAI no vino en JSON");
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("OpenAI esta ocupado. Intenta de nuevo en unos segundos");
        }

        throw new Error(data?.error?.message || "Error consultando OpenAI");
      }

      runtimeStats.openai.ok += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      return data;
    } catch (err) {
      runtimeStats.openai.error += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      if (err.name === "AbortError") {
        throw new Error(
          lane === "traduccion"
            ? "La traduccion tardo demasiado"
            : "OpenAI tardo demasiado en responder"
        );
      }

      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

module.exports = {
  ConcurrencyLimiter,
  suggestionsOpenAILimiter,
  translationOpenAILimiter,
  countOperatorSuggestionsRunning,
  countOperatorSuggestionsQueued,
  runSuggestionQueueByOperator,
  getSharedInFlight,
  obtenerOpenAILimiter,
  llamarOpenAI
};