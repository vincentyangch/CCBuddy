export default async function weather({ latitude, longitude, timezone, location_name }) {
  const WMO_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Icy fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Rain showers', 81: 'Moderate showers', 82: 'Violent showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail'
  };

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weathercode,windspeed_10m,precipitation_probability` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=${encodeURIComponent(timezone)}&forecast_days=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const data = await res.json();

  const c = data.current;
  const d = data.daily;

  const condition = WMO_CODES[c.weathercode] || `Code ${c.weathercode}`;
  const todayCondition = WMO_CODES[d.weathercode[0]] || `Code ${d.weathercode[0]}`;
  const tomorrowCondition = WMO_CODES[d.weathercode[1]] || `Code ${d.weathercode[1]}`;

  return {
    location: location_name,
    current: {
      temperature_f: Math.round(c.temperature_2m),
      feels_like_f: Math.round(c.apparent_temperature),
      condition,
      humidity_pct: c.relative_humidity_2m,
      wind_mph: Math.round(c.windspeed_10m),
      precip_chance_pct: c.precipitation_probability
    },
    today: {
      high_f: Math.round(d.temperature_2m_max[0]),
      low_f: Math.round(d.temperature_2m_min[0]),
      condition: todayCondition,
      precip_chance_pct: d.precipitation_probability_max[0],
      precip_in: d.precipitation_sum[0]
    },
    tomorrow: {
      high_f: Math.round(d.temperature_2m_max[1]),
      low_f: Math.round(d.temperature_2m_min[1]),
      condition: tomorrowCondition,
      precip_chance_pct: d.precipitation_probability_max[1],
      precip_in: d.precipitation_sum[1]
    }
  };
}
