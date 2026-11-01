/*
 * Фейковый API сервиса «Заправка в рейсе».
 * Работает прямо в браузере, без сервера:
 *   <script src="fake-api.js"></script>   → объект window.FakeApi
 * Состояние хранится в localStorage. FakeApi.reset() сбрасывает его.
 *
 * Все методы асинхронные и отвечают с задержкой, как настоящий сервер.
 * При ошибке Promise отклоняется объектом { name: 'ApiError', code, message, details }.
 * Поведение при ошибках и статусы заправки смотрите в коде ниже.
 *
 * Методы:
 *   getTrip()                    текущий рейс и лимит
 *   getDriverLocation()          координаты водителя
 *   getStations()                все АЗС сервиса
 *   getStation(id)               АЗС подробно: топливо, колонки, ограничения
 *   startFueling({ stationId, pump, fuel, liters, price, clientRequestId? })
 *   getFueling(id)               состояние заправки
 *   cancelFueling(id)
 *   getActiveFueling()           незавершённая заправка, если есть
 *
 * FakeApi.config.networkErrors = false отключает сетевые ошибки (только для отладки).
 */
(function () {
  'use strict';

  // ── генератор случайных чисел с зерном: данные одинаковые у всех ──
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const R = rng(20261016);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const round2 = (n) => Math.round(n * 100) / 100;

  // ── справочники ──
  const BRANDS = {
    'Магистраль':    { fuels: { diesel: 'ДТ', diesel_premium: 'ДТ Евро-5 Опти', ai92: 'АИ-92', ai95: 'АИ-95' }, max: 400 },
    'Север Ойл':     { fuels: { diesel: 'Дизель', ai92: 'Регуляр-92', ai95: 'Г-95' }, max: 300 },
    'ТрассНефть':    { fuels: { diesel: 'ДТ-Л', diesel_winter: 'ДТ Арктика', ai95: '95 Премиум' }, max: 400 },
    'Волга-Топливо': { fuels: { diesel: 'ДТ', ai92: 'АИ-92', ai95: 'АИ-95', ai100: 'АИ-100' }, max: 300 },
    'Колесо':        { fuels: { diesel: 'ДТ ЭКО', ai92: 'АИ-92', propane: 'Пропан' }, max: 150 }
  };
  const BASE_PRICE = { diesel: 74.2, diesel_premium: 76.9, diesel_winter: 79.4, ai92: 61.8, ai95: 67.3, ai100: 82.6, propane: 31.5 };
  const BRAND_K = { 'Магистраль': 1.0, 'Север Ойл': 0.985, 'ТрассНефть': 1.045, 'Волга-Топливо': 0.995, 'Колесо': 0.97 };

  const CITIES = [
    ['Москва', 55.75, 37.62, 'МКАД'], ['Санкт-Петербург', 59.93, 30.31, 'КАД'], ['Казань', 55.79, 49.12, 'М-7'],
    ['Нижний Новгород', 56.33, 44.0, 'М-7'], ['Владимир', 56.13, 40.41, 'М-7'], ['Чебоксары', 56.14, 47.25, 'М-7'],
    ['Тверь', 56.86, 35.9, 'М-10'], ['Великий Новгород', 58.52, 31.27, 'М-10'], ['Ярославль', 57.63, 39.87, 'М-8'],
    ['Вологда', 59.22, 39.89, 'М-8'], ['Рязань', 54.63, 39.74, 'М-5'], ['Пенза', 53.2, 45.0, 'М-5'],
    ['Самара', 53.2, 50.15, 'М-5'], ['Уфа', 54.74, 55.97, 'М-5'], ['Челябинск', 55.16, 61.4, 'М-5'],
    ['Екатеринбург', 56.84, 60.6, 'Р-242'], ['Пермь', 58.01, 56.25, 'Р-242'], ['Тюмень', 57.15, 65.53, 'Р-402'],
    ['Омск', 54.99, 73.37, 'Р-254'], ['Новосибирск', 55.03, 82.92, 'Р-254'], ['Красноярск', 56.01, 92.85, 'Р-255'],
    ['Тула', 54.19, 37.62, 'М-2'], ['Орёл', 52.97, 36.06, 'М-2'], ['Курск', 51.73, 36.19, 'М-2'],
    ['Белгород', 50.6, 36.59, 'М-2'], ['Воронеж', 51.67, 39.18, 'М-4'], ['Ростов-на-Дону', 47.23, 39.72, 'М-4'],
    ['Краснодар', 45.04, 38.98, 'М-4'], ['Ставрополь', 45.04, 41.97, 'Р-217'], ['Волгоград', 48.71, 44.51, 'Р-22'],
    ['Саратов', 51.53, 46.03, 'Р-228'], ['Тамбов', 52.72, 41.45, 'Р-22'], ['Липецк', 52.6, 39.57, 'Р-119'],
    ['Смоленск', 54.78, 32.05, 'М-1'], ['Брянск', 53.24, 34.36, 'А-240'], ['Калуга', 54.51, 36.26, 'М-3'],
    ['Иваново', 57.0, 40.97, 'Р-152'], ['Кострома', 57.77, 40.93, 'Р-600'], ['Киров', 58.6, 49.66, 'Р-176'],
    ['Ижевск', 56.85, 53.2, 'Р-320'], ['Ульяновск', 54.32, 48.4, 'Р-178'], ['Оренбург', 51.77, 55.1, 'Р-239']
  ];
  const DRIVER = { lat: 56.0712, lon: 40.0368 }; // М-7, между Москвой и Владимиром

  function makeStation(i, lat, lon, city, road, km) {
    const brand = pick(Object.keys(BRANDS));
    const conf = BRANDS[brand];
    const num = 100 + Math.floor(R() * 900);
    const long = R() < 0.3;
    if (long) pick(CITIES); // сохраняем последовательность случайных чисел
    const name = long
      ? `${brand} АЗС №${num} (трасса ${road}, ${km} км)`
      : `${brand} №${num}`;
    const address = `${city}, трасса ${road}, ${km} км${R() < 0.5 ? ', справа по ходу' : ''}`;
    const codes = Object.keys(conf.fuels);
    const prices = {};
    codes.forEach((c) => { prices[c] = round2(BASE_PRICE[c] * BRAND_K[brand] * (0.97 + R() * 0.06)); });
    const pumpsCount = 4 + Math.floor(R() * 5);
    const pumps = [];
    for (let p = 1; p <= pumpsCount; p++) {
      const fuels = codes.filter((c) => R() < 0.7);
      if (!fuels.length) fuels.push(codes[0]);
      const roll = R();
      pumps.push({ number: p, status: roll < 0.25 ? 'busy' : roll < 0.33 ? 'off' : 'free', fuels });
    }
    return {
      id: 'st_' + (1000 + i), brand, name, address,
      lat: round2(lat * 1000) / 1000, lon: round2(lon * 1000) / 1000,
      prices, fuelNames: conf.fuels, pumps, litersMin: 10, litersMax: conf.max
    };
  }

  const STATIONS = [];
  let idx = 0;
  // 292 АЗС по России
  while (STATIONS.length < 292) {
    const c = CITIES[STATIONS.length % CITIES.length];
    STATIONS.push(makeStation(idx++, c[1] + (R() - 0.5) * 0.6, c[2] + (R() - 0.5) * 0.9, c[0], c[3], 5 + Math.floor(R() * 300)));
  }
  // 8 АЗС рядом с водителем (5-40 км)
  for (let k = 0; k < 8; k++) {
    const st = makeStation(idx++, DRIVER.lat + (R() - 0.5) * 0.5, DRIVER.lon + (R() - 0.5) * 0.7, 'Владимирская область', 'М-7', 120 + Math.floor(R() * 60));
    STATIONS.push(st);
  }
  // гарантируем занятую колонку у ближайших
  // у ближайших: первая колонка занята, ещё две свободны и с дизелем
  const kmToDriver = (s) => Math.hypot((s.lat - DRIVER.lat) * 111, (s.lon - DRIVER.lon) * 62);
  STATIONS.filter((s) => kmToDriver(s) < 45).forEach((s) => {
    s.pumps[0].status = 'busy';
    s.pumps.slice(1, 3).forEach((p) => {
      p.status = 'free';
      if (!p.fuels.includes('diesel')) p.fuels.unshift('diesel');
    });
  });
  // перемешиваем: порядок API не связан с расстоянием
  for (let i = STATIONS.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [STATIONS[i], STATIONS[j]] = [STATIONS[j], STATIONS[i]];
  }
  // «Волга-Топливо» под Казанью - на рубль дешевле «Колеса» под Владимиром
  STATIONS.filter((s) => s.brand === 'Волга-Топливо' && Math.hypot((s.lat - 55.79) * 111, (s.lon - 49.12) * 62) < 60)
    .forEach((s) => { s.prices.diesel = 70.7; });
  const BY_ID = {};
  STATIONS.forEach((s) => { BY_ID[s.id] = s; });

  // ── состояние ──
  const KEY = 'fakeApi.zapravka.v1';
  const INITIAL = () => ({ limitLeft: 9340, fuelings: [], priceShift: {} });
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)) || INITIAL(); } catch (e) { state = INITIAL(); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* без хранилища тоже работает */ } }

  const config = { networkErrors: true };

  function ApiError(code, message, details) {
    const e = new Error(message);
    e.name = 'ApiError'; e.code = code; e.details = details || {};
    return e;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const latency = () => wait(300 + Math.random() * 1200);
  const netFail = () => config.networkErrors && Math.random() < 0.1;

  function priceOf(st, code) {
    return round2(st.prices[code] + (state.priceShift[st.id + ':' + code] || 0));
  }

  // ── жизненный цикл заправки по времени ──
  const SPEED = 5; // литров в секунду (ускорено для прототипа)
  function progress(f) {
    if (f.status === 'completed' || f.status === 'cancelled') return f;
    const t = (Date.now() - f.createdAt) / 1000;
    if (f.outcome === 'station') {
      if (t >= 6) return finish(f, 'cancelled', 'STATION_NO_RESPONSE');
      f.status = 'accepted'; return f;
    }
    if (t < 3) { f.status = 'accepted'; return f; }
    if (f.outcome === 'timeout') {
      if (t >= 60) return finish(f, 'cancelled', 'PUMP_TIMEOUT');
      f.status = 'waiting_nozzle'; return f;
    }
    if (t < 10) { f.status = 'waiting_nozzle'; return f; }
    const poured = Math.min(f.targetLiters, round2((t - 10) * SPEED));
    if (poured < f.targetLiters) { f.status = 'fueling'; f.currentLiters = poured; f.updatedAt = Date.now(); return f; }
    f.currentLiters = f.targetLiters;
    return finish(f, 'completed');
  }
  function finish(f, status, reason) {
    f.status = status; f.updatedAt = Date.now();
    if (status === 'completed') {
      f.factLiters = f.targetLiters;
      f.factAmount = round2(f.factLiters * f.price);
    } else {
      f.reason = reason; f.currentLiters = 0;
    }
    if (!f.settled) {
      state.limitLeft = round2(state.limitLeft + f.amountHeld - (f.factAmount || 0));
      f.settled = true;
    }
    return f;
  }
  function tickAll() { state.fuelings.forEach(progress); save(); }
  function view(f) {
    const { outcome, targetLiters, settled, clientRequestId, ...pub } = f;
    return JSON.parse(JSON.stringify(pub));
  }

  // ── методы ──
  async function call(fn, failAfter) {
    await latency();
    if (!failAfter && netFail()) throw ApiError('NETWORK_ERROR', 'Нет связи с сервером');
    tickAll();
    const res = fn();
    // иногда запрос дошёл до сервера, а ответ потерялся
    if (failAfter && netFail()) { save(); throw ApiError('NETWORK_ERROR', 'Нет связи с сервером'); }
    save();
    return res;
  }

  const api = {
    config,

    getTrip: () => call(() => ({
      id: 'trip_5817', from: 'Москва', to: 'Казань', date: '2026-10-16',
      truck: 'А123ВС 77', limitTotal: 15000, limitLeft: state.limitLeft
    })),

    getDriverLocation: () => call(() => ({ ...DRIVER })),

    getStations: () => call(() => STATIONS.map((s) => {
      const prices = {};
      Object.keys(s.prices).forEach((c) => { prices[c] = priceOf(s, c); });
      return { id: s.id, brand: s.brand, name: s.name, address: s.address, lat: s.lat, lon: s.lon, prices };
    })),

    getStation: (id) => call(() => {
      const s = BY_ID[id];
      if (!s) throw ApiError('STATION_NOT_FOUND', 'АЗС не найдена');
      const prices = {};
      Object.keys(s.prices).forEach((c) => { prices[c] = priceOf(s, c); });
      return {
        id: s.id, brand: s.brand, name: s.name, address: s.address, lat: s.lat, lon: s.lon, prices,
        fuels: Object.keys(s.fuelNames).map((c) => ({ code: c, name: s.fuelNames[c], price: prices[c] })),
        pumps: s.pumps.map((p) => ({ number: p.number, status: p.status, fuels: p.fuels.slice() })),
        litersMin: s.litersMin, litersMax: s.litersMax
      };
    }),

    startFueling: (req) => call(() => {
      req = req || {};
      const { stationId, pump, fuel, liters, price, clientRequestId } = req;
      if (clientRequestId) {
        const same = state.fuelings.find((f) => f.clientRequestId === clientRequestId);
        if (same) return view(same);
      }
      if (!stationId || pump == null || !fuel || liters == null || price == null) {
        throw ApiError('INVALID_REQUEST', 'Нужны stationId, pump, fuel, liters, price');
      }
      const s = BY_ID[stationId];
      if (!s) throw ApiError('STATION_NOT_FOUND', 'АЗС не найдена');
      const p = s.pumps.find((x) => x.number === Number(pump));
      if (!p || p.status !== 'free' || Math.random() < 0.08) throw ApiError('PUMP_BUSY', 'Колонка занята');
      if (!p.fuels.includes(fuel)) throw ApiError('FUEL_NOT_AVAILABLE', 'На этой колонке нет такого топлива');
      const L = Number(liters);
      if (!(L >= s.litersMin && L <= s.litersMax)) {
        throw ApiError('INVALID_LITERS', 'Недопустимый объём', { min: s.litersMin, max: s.litersMax });
      }
      const current = priceOf(s, fuel);
      if (Math.abs(current - Number(price)) > 0.001) {
        throw ApiError('PRICE_CHANGED', 'Цена изменилась', { oldPrice: Number(price), newPrice: current });
      }
      if (Math.random() < 0.25) {
        const k = s.id + ':' + fuel;
        state.priceShift[k] = round2((state.priceShift[k] || 0) + 0.3 + Math.random() * 0.9);
        throw ApiError('PRICE_CHANGED', 'Цена изменилась', { oldPrice: current, newPrice: priceOf(s, fuel) });
      }
      const amount = round2(L * current);
      if (amount > state.limitLeft) {
        throw ApiError('LIMIT_EXCEEDED', 'Не хватает лимита', { available: state.limitLeft });
      }
      const roll = Math.random();
      const outcome = roll < 0.6 ? 'ok' : roll < 0.78 ? 'underfill' : roll < 0.94 ? 'timeout' : 'station';
      const f = {
        id: 'fu_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        stationId: s.id, stationName: s.name, pump: p.number, fuel, fuelName: s.fuelNames[fuel],
        liters: L, price: current, amountHeld: amount,
        status: 'accepted', currentLiters: 0, factLiters: null, factAmount: null, reason: null,
        createdAt: Date.now(), updatedAt: Date.now(),
        outcome, targetLiters: outcome === 'underfill' ? round2(L * (0.55 + Math.random() * 0.35)) : L,
        clientRequestId: clientRequestId || null, settled: false
      };
      state.limitLeft = round2(state.limitLeft - amount);
      state.fuelings.push(f);
      return view(f);
    }, true),

    getFueling: (id) => call(() => {
      const f = state.fuelings.find((x) => x.id === id);
      if (!f) throw ApiError('NOT_FOUND', 'Заправка не найдена');
      return view(f);
    }),

    cancelFueling: (id) => call(() => {
      const f = state.fuelings.find((x) => x.id === id);
      if (!f) throw ApiError('NOT_FOUND', 'Заправка не найдена');
      if (f.status !== 'accepted' && f.status !== 'waiting_nozzle') throw ApiError('CANNOT_CANCEL', 'Налив уже начался или заправка завершена');
      return view(finish(f, 'cancelled', 'DRIVER_CANCELLED'));
    }),

    getActiveFueling: () => call(() => {
      const f = state.fuelings.slice().reverse().find((x) => x.status !== 'completed' && x.status !== 'cancelled');
      return f ? view(f) : null;
    }),

    reset() { state = INITIAL(); save(); }
  };

  if (typeof window !== 'undefined') window.FakeApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
