// Calcule geografice folosite atât pe server (require) cât și în browser (window.Geo).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Geo = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const EARTH_RADIUS_M = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  function isValidLatLng(lat, lng) {
    return (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  // Distanța în metri între două puncte {lat, lng} (formula haversine).
  function distanceMeters(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Direcția de deplasare de la a la b, în grade (0 = nord, 90 = est).
  function bearingDegrees(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x =
      Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Avansează de la `from` spre `to` cu cel mult `meters`; nu depășește destinația.
  function moveTowards(from, to, meters) {
    const total = distanceMeters(from, to);
    if (total <= meters || total === 0) return { lat: to.lat, lng: to.lng };
    const f = meters / total;
    return {
      lat: from.lat + (to.lat - from.lat) * f,
      lng: from.lng + (to.lng - from.lng) * f,
    };
  }

  // Timp estimat (minute, rotunjit în sus, minim 1) pentru o distanță la o viteză medie urbană.
  function etaMinutes(meters, avgSpeedKmh) {
    if (!(avgSpeedKmh > 0)) return null;
    // Distanța în linie dreaptă e mai mică decât cea pe străzi; factor tipic oraș ≈ 1.3.
    const roadMeters = meters * 1.3;
    return Math.max(1, Math.ceil(roadMeters / ((avgSpeedKmh * 1000) / 60)));
  }

  function formatDistance(meters) {
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters / 1000).toFixed(1).replace('.', ',') + ' km';
  }

  return { isValidLatLng, distanceMeters, bearingDegrees, moveTowards, etaMinutes, formatDistance };
});
