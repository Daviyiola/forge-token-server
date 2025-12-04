// summaries.js — compute daily summaries (comfort, occupancy, lights, simple energy)
// <script type="module" src="/js/summaries.js"></script>

export const SUMMARIES = (() => {
  const state = {
    roomName: null,
    range: null,          // { startISO, stopISO, start, stop }
    summary: null,
    loading: false,
    error: null,
  };

  const log = (...args) => {
    // console.debug('[SUMMARIES]', ...args);
  };

  const authHeaders = () => ({
    'Content-Type': 'application/json'
  });

  function getPrimaryRoom() {
    try {
      if (window.METRICS && typeof window.METRICS.getPrimaryRoomName === 'function') {
        return window.METRICS.getPrimaryRoomName();
      }
    } catch (e) {
      console.warn('SUMMARIES: getPrimaryRoom failed', e);
    }
    return state.roomName || null;
  }

  function setRoomName(name) {
    if (!name || typeof name !== 'string') return;
    state.roomName = name;
  }

  function startOfDayLocal(date) {
    const d = date instanceof Date ? new Date(date) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  function buildDayRange(offsetDays = 0) {
    const now = new Date();
    const base = startOfDayLocal(now);
    if (offsetDays) base.setDate(base.getDate() + offsetDays);
    const start = base;
    const stop = new Date(base.getTime() + 24 * 60 * 60 * 1000);
    return {
      start,
      stop,
      startISO: start.toISOString(),
      stopISO: stop.toISOString()
    };
  }

  function formatPeriodLabel(range) {
    const d = new Date(range.start);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  async function fetchSeries({ measurement, fields, startISO, stopISO, every, tagKey, device }) {
    const params = new URLSearchParams();
    if (measurement) params.set('measurement', measurement);
    if (fields) params.set('fields', fields);
    if (startISO && stopISO) {
      params.set('start', startISO);
      params.set('stop', stopISO);
      params.set('every', every || '5m');
    } else {
      params.set('minutes', '1440');
      params.set('every', every || '5m');
    }
    if (tagKey) params.set('tagKey', tagKey);
    if (device) params.set('device', device);

    const url = `/api/series?${params.toString()}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status}`);
    }
    const data = await res.json();
    return data.series || {};
  }

  function safeArray(series, field) {
    return Array.isArray(series[field]) ? series[field] : [];
  }

  function mean(nums) {
    const arr = nums.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!arr.length) return null;
    return arr.reduce((a,b)=>a+b,0) / arr.length;
  }

  function min(nums) {
    const arr = nums.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!arr.length) return null;
    return Math.min(...arr);
  }

  function max(nums) {
    const arr = nums.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!arr.length) return null;
    return Math.max(...arr);
  }

  function percentile(nums, p) {
    const arr = nums
      .filter(v => typeof v === 'number' && Number.isFinite(v))
      .sort((a,b)=>a-b);
    if (!arr.length) return null;
    const idx = Math.floor((p/100) * (arr.length - 1));
    return arr[idx];
  }

  function buildComfortBlock(envSeries) {
    const tempPts = safeArray(envSeries, 'temp_f');
    const rhPts   = safeArray(envSeries, 'rh_pct');
    const co2Pts  = safeArray(envSeries, 'eco2_ppm');
    const tvocPts = safeArray(envSeries, 'tvoc_ppb');

    const tempVals = tempPts.map(p => p.v);
    const rhVals   = rhPts.map(p => p.v);
    const co2Vals  = co2Pts.map(p => p.v);
    const tvocVals = tvocPts.map(p => p.v);

    const withinBandPts = tempVals.filter(
      v => typeof v === 'number' && v >= 68 && v <= 75
    );
    const tempBandPct = tempVals.length
      ? Math.round((withinBandPts.length / tempVals.length) * 100)
      : null;

    const co2Exceed = co2Vals.filter(v => typeof v === 'number' && v > 1000);
    // assume 5 min buckets → minutes = count * 5
    const co2ExceedMinutes = co2Exceed.length * 5;

    const co2Avg = mean(co2Vals);
    const co2Min = min(co2Vals);
    const co2Max = max(co2Vals);

    const tvocAvg = mean(tvocVals);
    const tvocMin = min(tvocVals);
    const tvocMax = max(tvocVals);

    let tvocRating = null;
    if (tvocAvg != null) {
      if (tvocAvg < 150) tvocRating = 'Good';
      else if (tvocAvg < 400) tvocRating = 'Moderate';
      else tvocRating = 'Poor';
    }

    return {
      temp: {
        avg: mean(tempVals),
        min: min(tempVals),
        max: max(tempVals),
        withinBandPct: tempBandPct
      },
      rh: {
        avg: mean(rhVals),
        min: min(rhVals),
        max: max(rhVals)
      },
      co2: {
        avg: co2Avg,
        min: co2Min,
        max: co2Max,
        exceedMinutes: co2ExceedMinutes
      },
      tvoc: {
        avg: tvocAvg,
        min: tvocMin,
        max: tvocMax,
        rating: tvocRating
      }
    };
  }

  function buildOccupancyAndLights(envSeries, occSeries) {
    const lightPts = safeArray(envSeries, 'light_on_num');
    const occPts   = safeArray(occSeries, 'count');

    const totalSteps = Math.max(lightPts.length, occPts.length);
    if (!totalSteps) {
      return {
        occupancy: {
          seatHours: 0,
          peakCount: 0,
          presencePct: 0,
          firstSeenISO: null,
          lastSeenISO: null,
          peakTimeISO: null,
          avg8to8: null
        },
        lights: {
          onMinutes: 0,
          wastedMinutes: 0,
          presencePct: 0
        },
        trends: {
          hourlyOcc: new Array(24).fill(0),
          hourlyLights: new Array(24).fill(0)
        }
      };
    }

    const stepMinutes = 5; // matches /api/series every: '5m'

    let seatMinutes       = 0;
    let peakCount         = 0;
    let peakTimeISO       = null;
    let occSamplesNonZero = 0;
    let occSampleSlots    = 0;
    let firstSeenISO      = null;
    let lastSeenISO       = null;

    let sum8to8           = 0;
    let count8to8         = 0;

    let onMinutes         = 0;
    let wastedMinutes     = 0;
    let lightOnSamples    = 0;
    let lightSampleSlots  = 0;

    const hourlyOccMinutes   = new Array(24).fill(0);
    const hourlyLightSamples = new Array(24).fill(0);
    const hourlyLightOn      = new Array(24).fill(0);

    for (let i = 0; i < totalSteps; i++) {
      const occPoint   = occPts[i];
      const lightPoint = lightPts[i];

      // treat missing datapoint as null, not 0
      const hasOcc = !!occPoint && typeof occPoint.v === 'number' && Number.isFinite(occPoint.v);
      const occ    = hasOcc ? occPoint.v : null;

      const hasLight = !!lightPoint && typeof lightPoint.v === 'number' && Number.isFinite(lightPoint.v);
      const light    = hasLight ? lightPoint.v : 0;

      const tsStr = (occPoint && occPoint.t) || (lightPoint && lightPoint.t);
      const ts    = tsStr ? new Date(tsStr) : null;
      const hour  = ts ? ts.getHours() : 0;

      // Occupancy stats
      if (hasOcc) {
        occSampleSlots += 1;

        const clampedOcc = Math.max(0, occ);
        seatMinutes += clampedOcc * stepMinutes;

        if (clampedOcc > 0) {
          occSamplesNonZero += 1;
          if (!firstSeenISO && ts) firstSeenISO = ts.toISOString();
          if (ts) lastSeenISO = ts.toISOString();
        }

        if (clampedOcc > peakCount) {
          peakCount = clampedOcc;
          peakTimeISO = ts ? ts.toISOString() : null;
        }

        // hourly seat minutes
        hourlyOccMinutes[hour] += clampedOcc * stepMinutes;

        // avg8to8: only 8am to 8pm (local hours 8 to 19 inclusive)
        if (ts && hour >= 8 && hour <= 19) {
          sum8to8 += clampedOcc;
          count8to8 += 1;
        }
      }

      // Lights stats
      if (hasLight) {
        lightSampleSlots += 1;
        onMinutes += light > 0 ? stepMinutes : 0;

        if (light > 0) {
          lightOnSamples += 1;
          // WASTE: lights on AND we know occupancy is zero
          if (hasOcc && occ <= 0) {
            wastedMinutes += stepMinutes;
          }
          hourlyLightOn[hour] += 1;
        }
        hourlyLightSamples[hour] += 1;
      }
    }

    const presencePct =
      occSampleSlots ? Math.round((occSamplesNonZero / occSampleSlots) * 100) : 0;

    const lightsPresencePct =
      lightSampleSlots ? Math.round((lightOnSamples / lightSampleSlots) * 100) : 0;

    const hourlyOcc = hourlyOccMinutes.map(m => m / 60); // seat hours per hour
    const hourlyLights = hourlyLightSamples.map((n, idx) =>
      n ? Math.round((hourlyLightOn[idx] / n) * 100) : 0
    );

    const avg8to8 =
      count8to8 > 0 ? (sum8to8 / count8to8) : null;

    return {
      occupancy: {
        seatHours: seatMinutes / 60, // keep internal
        peakCount,
        presencePct,
        firstSeenISO,
        lastSeenISO,
        peakTimeISO,
        avg8to8
      },
      lights: {
        onMinutes,
        wastedMinutes,
        presencePct: lightsPresencePct
      },
      trends: {
        hourlyOcc,
        hourlyLights
      }
    };
  }

  function buildEnergyBlock(plugSeries) {
    const wattsPts = safeArray(plugSeries, 'watts');
    const wattsVals = wattsPts
      .map(p => p.v)
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (!wattsVals.length) {
      return {
        kwhTotal: null,
        peakWatts: null,
        avgWatts: null
      };
    }
    const peakWatts = max(wattsVals);
    const avgWatts  = mean(wattsVals);
    // approximate kWh: sum(watts) * 5min / 60 / 1000
    const stepMinutes = 5;
    const kwhTotal = wattsVals.reduce(
      (acc, w) => acc + (w * stepMinutes / 60 / 1000),
      0
    );
    return {
      kwhTotal,
      peakWatts,
      avgWatts
    };
  }

  function buildHighlights(summary) {
    const hl      = [];
    const occ     = summary.occupancy;
    const comfort = summary.comfort;
    const lights  = summary.occupancyLights.lights;
    const energy  = summary.energy;

    // Peak occupancy highlight
    if (occ && typeof occ.peakCount === 'number' && occ.peakCount > 0) {
      const peakIso = occ.peakTimeISO || occ.firstSeenISO || null;
      const when = peakIso
        ? new Date(peakIso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';
      hl.push(
        `Peak occupancy was ${occ.peakCount} people${when ? ` around ${when}` : ''}.`
      );
    }

    // Lights highlights (hours, one decimal)
    if (lights && typeof lights.onMinutes === 'number' && lights.onMinutes > 0) {
      const onHours = lights.onMinutes / 60;
      hl.push(
        `Lights were on for ${onHours.toFixed(1)} hours.`
      );

      const waste = lights.wastedMinutes || 0;
      if (waste > 0) {
        const wasteHours = waste / 60;
        hl.push(
          `Lights were wastefully on for ${wasteHours.toFixed(1)} hours.`
        );
      }
    }

    // CO2 exceedance highlight (minutes)
    if (comfort && comfort.co2 && typeof comfort.co2.exceedMinutes === 'number') {
      const mins = Math.round(comfort.co2.exceedMinutes);
      if (mins > 0) {
        hl.push(
          `CO₂ was above the healthy threshold for ${mins} minutes.`
        );
      } else {
        hl.push('CO₂ stayed below the threshold all day.');
      }
    }

    // TVOC rating highlight
    if (comfort && comfort.tvoc && comfort.tvoc.rating) {
      hl.push(
        `TVOC air quality was ${comfort.tvoc.rating.toLowerCase()} today.`
      );
    }

    // Energy highlight (WWH015 only)
    if (summary.roomName === 'WWH015' && energy && typeof energy.kwhTotal === 'number') {
      hl.push(
        `Approximate plug energy usage was ${energy.kwhTotal.toFixed(2)} kWh.`
      );
    }

    return hl;
  }

  function buildRecommendations(summary) {
    const recs   = [];
    const occ    = summary.occupancy;
    const comfort = summary.comfort;
    const lights  = summary.occupancyLights.lights;
    const energy  = summary.energy; // not used now, but kept for future

    if (lights && lights.wastedMinutes > 15) {
      const hours = lights.wastedMinutes / 60;
      recs.push({
        id: 'energy_auto_off',
        title: 'Enable Auto Off for Lights',
        body: `Lights were on for roughly ${Math.round(lights.wastedMinutes)} minutes while occupancy was zero. Adding an auto off rule after 10 to 15 minutes of inactivity could reduce waste by around ${hours.toFixed(1)} hours per week if this pattern repeats.`
      });
    }

    if (comfort && comfort.co2 && comfort.co2.exceedMinutes > 30) {
      recs.push({
        id: 'ventilation_adjust',
        title: 'Improve Ventilation at Peak Times',
        body: `CO₂ exceeded the recommended threshold for about ${comfort.co2.exceedMinutes} minutes. Consider boosting ventilation or opening the space during peak occupancy.`
      });
    }

    if (occ && occ.seatHours < 2 && occ.presencePct < 20) {
      recs.push({
        id: 'low_utilization',
        title: 'Low Utilization Detected',
        body: 'This room saw very light usage today. If this pattern holds across several days, you may be able to consolidate activities into fewer rooms or time slots.'
      });
    }

    if (comfort && comfort.temp && comfort.temp.withinBandPct != null && comfort.temp.withinBandPct < 60) {
      recs.push({
        id: 'comfort_band',
        title: 'Temperature Often Outside Comfort Band',
        body: `Only about ${comfort.temp.withinBandPct}% of readings were within the 68 to 75°F comfort band. Consider tuning the thermostat schedule or investigating drafts and equipment heat.`
      });
    }

    if (recs.length === 0) {
      recs.push({
        id: 'all_good',
        title: 'No Issues Detected',
        body: 'No obvious comfort, utilization, or energy waste issues were detected for this period.'
      });
    }

    return recs;
  }

  async function loadDaily(offsetDays = 0) {
    const room = getPrimaryRoom();
    if (!room) {
      state.error = 'No primary room selected';
      state.summary = null;
      window.dispatchEvent(new CustomEvent('summaries:updated', { detail: null }));
      return null;
    }

    setRoomName(room);

    const range = buildDayRange(offsetDays);
    state.range = {
      startISO: range.startISO,
      stopISO: range.stopISO,
      start: range.start,
      stop: range.stop
    };
    state.loading = true;
    state.error = null;
    window.dispatchEvent(new CustomEvent('summaries:loading', { detail: true }));

    try {
      const [envSeries, occSeries, plugSeries] = await Promise.all([
        fetchSeries({
          measurement: 'env',
          fields: 'temp_f,rh_pct,eco2_ppm,tvoc_ppb,light_on_num',
          startISO: range.startISO,
          stopISO: range.stopISO,
          every: '5m',
          tagKey: 'room',
          device: room
        }),
        fetchSeries({
          measurement: 'room_count',
          fields: 'count',
          startISO: range.startISO,
          stopISO: range.stopISO,
          every: '5m',
          tagKey: 'room',
          device: room
        }),
        fetchSeries({
          measurement: 'plugData',
          fields: 'watts',
          startISO: range.startISO,
          stopISO: range.stopISO,
          every: '5m'
        }).catch(() => ({}))
      ]);

      const comfort   = buildComfortBlock(envSeries);
      const occLights = buildOccupancyAndLights(envSeries, occSeries);
      const energy    = buildEnergyBlock(plugSeries);

      const periodLabel = formatPeriodLabel(range);

      const summary = {
        periodLabel,
        range: {
          startISO: range.startISO,
          stopISO: range.stopISO
        },
        roomName: room,
        comfort,
        occupancy: occLights.occupancy,
        occupancyLights: {
          lights: occLights.lights
        },
        energy,
        trends: {
          hourlyOcc: occLights.trends.hourlyOcc,
          hourlyLights: occLights.trends.hourlyLights
        }
      };

      summary.highlights      = buildHighlights(summary);
      summary.recommendations = buildRecommendations(summary);

      state.summary = summary;
      state.loading = false;
      window.dispatchEvent(new CustomEvent('summaries:updated', { detail: summary }));
      window.dispatchEvent(new CustomEvent('summaries:loading', { detail: false }));
      log('Daily summary', summary);
      return summary;
    } catch (err) {
      console.error('SUMMARIES: load failed', err);
      state.error = String(err?.message || err) || 'Failed to load summary';
      state.summary = null;
      state.loading = false;
      window.dispatchEvent(new CustomEvent('summaries:updated', { detail: null }));
      window.dispatchEvent(new CustomEvent('summaries:loading', { detail: false }));
      return null;
    }
  }

  function getState() {
    return { ...state };
  }

  const api = {
    loadToday: () => loadDaily(0),
    loadOffset: (offsetDays) => loadDaily(offsetDays),
    getState,
    setRoomName
  };

  window.SUMMARIES = api;
  return api;
})();

export default SUMMARIES;
