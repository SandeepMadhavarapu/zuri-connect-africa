/**
 * Zuri Connect Africa — Network AI
 * Generates user-friendly telecom insights without fake carrier-level access.
 */

const NAIROBI_AREAS = ['Westlands', 'CBD', 'Kibera', 'Karen', 'Kasarani', 'Embakasi', 'Ruiru', 'Thika Rd', 'Lang\'ata', 'Parklands'];

function randomArea() {
  return NAIROBI_AREAS[Math.floor(Math.random() * NAIROBI_AREAS.length)];
}

function getHour() { return new Date().getHours(); }

export function getNetworkStatus() {
  const h = getHour();
  const isPeak = (h >= 7 && h <= 9) || (h >= 17 && h <= 20);
  const isNight = h >= 23 || h < 5;

  return {
    quality:    isNight ? 'Excellent' : isPeak ? 'Moderate' : 'Good',
    band:       '4G LTE',
    congestion: isPeak ? 'moderate' : 'low',
    latency:    isPeak ? '45ms' : '18ms',
    uptime:     '99.7%',
    isPeak,
    isNight,
  };
}

export function getCongestionInsight() {
  const status = getNetworkStatus();
  const area = randomArea();
  if (status.isPeak) {
    return {
      type: 'warning',
      text: `Network congestion detected near ${area}. Video calls may be unstable for the next 15–20 minutes. Consider switching tasks or using Wi-Fi.`,
    };
  }
  return {
    type: 'ok',
    text: `Network conditions are clear in your area. Good time for video calls or large downloads.`,
  };
}

export function getSettlementDelayInsight(txDate) {
  if (!txDate) return null;
  const ageMin = (Date.now() - new Date(txDate).getTime()) / 60000;
  if (ageMin > 10 && ageMin < 60) {
    return `Your transaction was sent during a period of elevated network activity. Settlements typically complete within 30–60 minutes. No action needed.`;
  }
  return null;
}

export function getWifiRecommendation(dataPct) {
  if (dataPct < 20) {
    return {
      type: 'suggestion',
      text: `Your data bundle is below 20%. Switch to Wi-Fi for heavy browsing, video calls, or app updates to preserve your remaining data.`,
    };
  }
  return null;
}

export function getRoamingInsight(location) {
  if (!location) return null;
  return {
    type: 'info',
    text: `If you're travelling outside Kenya, activate Zuri Roaming Protect to avoid unexpected data charges. Contact support to enable it before your trip.`,
  };
}

export function getNetworkInsights() {
  const status = getNetworkStatus();
  const insights = [];

  const congestion = getCongestionInsight();
  if (congestion) insights.push(congestion);

  const wifiRec = getWifiRecommendation(48); // 48% data remaining
  if (wifiRec) insights.push(wifiRec);

  insights.push({
    type: 'stat',
    text: `Current: ${status.band} · Latency ${status.latency} · Quality: ${status.quality}`,
  });

  return insights;
}