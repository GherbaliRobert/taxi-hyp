// Jurnalul de acțiuni: cine a făcut ce și când, cu un rezumat lizibil.
const { ROLE_LABELS } = require('./accounts');

// Acțiunile au forma „categorie_acțiune”; categoria se folosește la filtrarea jurnalului.
const AUDIT_CATEGORIES = ['auth', 'ride', 'car', 'user', 'history'];

const CAR_FIELDS = { plate: 'număr', model: 'model', driver: 'șofer' };
const USER_FIELDS = { name: 'nume', username: 'utilizator', role: 'rol' };

function describeChanges(changes, labels, format = (field, value) => value) {
  const parts = [];
  for (const [field, label] of Object.entries(labels)) {
    if (!changes[field]) continue;
    const [before, after] = changes[field].map((value) => format(field, value) || '—');
    parts.push(`${label}: ${before} → ${after}`);
  }
  return parts;
}

function carChangeSummary(plate, changes) {
  const parts = describeChanges(changes, CAR_FIELDS);
  if (changes.pin) parts.push('PIN nou');
  return parts.length ? `${plate}: ${parts.join('; ')}` : '';
}

function userChangeSummary(name, changes) {
  const parts = describeChanges(changes, USER_FIELDS, (field, value) => (field === 'role' ? ROLE_LABELS[value] : value));
  return parts.length ? `${name}: ${parts.join('; ')}` : '';
}

function userLabel(user) {
  return `${user.name} (${user.username})`;
}

function rideSummary(ride) {
  // O comandă încă neacceptată nu are mașină.
  return [`Cursa #${ride.id}`, ride.customerName, ride.carPlate].filter(Boolean).join(' · ');
}

function createAuditLog(repo, now = Date.now) {
  return {
    /** `actor` este utilizatorul autentificat ({ id, name }) sau null (ex. autentificare eșuată). */
    log(actor, action, target, summary, ip) {
      repo.insertAudit({
        ts: now(),
        userId: actor ? actor.id : null,
        userName: actor ? actor.name : '',
        action,
        target: target || '',
        summary: summary || '',
        ip: ip || '',
      });
    },
    search: (filters, page) => repo.searchAudit(filters, page),
  };
}

module.exports = { createAuditLog, carChangeSummary, userChangeSummary, userLabel, rideSummary, AUDIT_CATEGORIES };
