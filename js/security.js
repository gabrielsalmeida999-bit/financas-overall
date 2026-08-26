/* ==========================================================================
   security.js — bloqueio por PIN, biometria (quando suportada) e auto-bloqueio.
   O PIN NUNCA é armazenado. Guardamos apenas: salt aleatório + hash PBKDF2.
   ========================================================================== */

import { log, logWarn, logError, nowTs } from './core.js';
import { getRawSetting, setRawSetting, deleteRawSetting } from './repo.js';

const KEY = 'security';
const ITERATIONS = 210000;
const HASH = 'SHA-256';
const KEYLEN = 32;
const SESSION_KEY = 'overall_financas_unlocked_until';
const MAX_ATTEMPTS = 8;

/* ------------------------------- Base64 ---------------------------------- */

function toB64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------ Derivação -------------------------------- */

function hasCrypto() {
  return !!(globalThis.crypto && crypto.subtle && crypto.getRandomValues);
}

async function derive(pin, saltBytes, iterations) {
  if (!hasCrypto()) throw new Error('Este navegador não oferece as funções de segurança necessárias.');
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: HASH },
    material,
    KEYLEN * 8
  );
  return toB64(bits);
}

/** Comparação em tempo constante. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ----------------------------- Configuração ------------------------------ */

export async function getSecurity() {
  const raw = await getRawSetting(KEY);
  return raw && typeof raw === 'object' ? raw : { enabled: false };
}

export async function isLockEnabled() {
  const s = await getSecurity();
  return !!(s.enabled && s.hash && s.salt);
}

export function isSupported() { return hasCrypto(); }

/** Define/redefine o PIN. Só guarda salt + hash. */
export async function setPin(pin, options = {}) {
  const clean = String(pin || '').replace(/\D/g, '');
  if (clean.length < 4 || clean.length > 8) {
    throw new Error('O PIN deve ter entre 4 e 8 dígitos.');
  }
  if (/^(\d)\1+$/.test(clean)) {
    throw new Error('Escolha um PIN com dígitos diferentes.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(clean, salt, ITERATIONS);
  const current = await getSecurity();
  const record = {
    enabled: true,
    algorithm: 'PBKDF2',
    hash: HASH,
    iterations: ITERATIONS,
    salt: toB64(salt),
    hashValue: hash,
    length: clean.length,
    autoLockMinutes: options.autoLockMinutes ?? current.autoLockMinutes ?? 5,
    biometric: current.biometric || null,
    attempts: 0,
    updatedAt: nowTs()
  };
  await setRawSetting(KEY, record);
  unlock();
  log('security.pin.set', { iterations: ITERATIONS });
  return true;
}

export async function verifyPin(pin) {
  const s = await getSecurity();
  if (!s.enabled || !s.hashValue || !s.salt) return true;
  if ((s.attempts || 0) >= MAX_ATTEMPTS) {
    const wait = lockoutRemaining(s);
    if (wait > 0) throw new Error(`Muitas tentativas. Aguarde ${wait}s.`);
  }
  const clean = String(pin || '').replace(/\D/g, '');
  const hash = await derive(clean, fromB64(s.salt), s.iterations || ITERATIONS);
  const ok = safeEqual(hash, s.hashValue);

  s.attempts = ok ? 0 : (s.attempts || 0) + 1;
  s.lastAttemptAt = nowTs();
  await setRawSetting(KEY, s);

  if (ok) { unlock(); log('security.unlock'); }
  else logWarn('security.unlock.fail', { attempts: s.attempts });
  return ok;
}

function lockoutRemaining(s) {
  const over = (s.attempts || 0) - MAX_ATTEMPTS;
  if (over < 0) return 0;
  const waitMs = Math.min(30000 * (over + 1), 300000);
  const elapsed = nowTs() - (s.lastAttemptAt || 0);
  return Math.max(0, Math.ceil((waitMs - elapsed) / 1000));
}

export async function attemptsInfo() {
  const s = await getSecurity();
  return { attempts: s.attempts || 0, max: MAX_ATTEMPTS, lockoutSeconds: lockoutRemaining(s) };
}

/** Remove a proteção (exige o PIN atual). */
export async function disableLock(currentPin) {
  const ok = await verifyPin(currentPin);
  if (!ok) throw new Error('PIN incorreto.');
  await deleteRawSetting(KEY);
  unlock();
  logWarn('security.disabled');
  return true;
}

export async function setAutoLockMinutes(minutes) {
  const s = await getSecurity();
  s.autoLockMinutes = Math.max(0, Math.min(120, Math.floor(Number(minutes) || 0)));
  await setRawSetting(KEY, s);
  restartIdleTimer();
  return s.autoLockMinutes;
}

export async function getPinLength() {
  const s = await getSecurity();
  return s.length || 4;
}

/* ------------------------------- Biometria ------------------------------- */
/* WebAuthn com autenticador da plataforma. Se não houver suporte, o app      */
/* continua funcionando normalmente apenas com PIN.                           */

export async function biometricAvailable() {
  try {
    if (!window.PublicKeyCredential) return false;
    if (!window.isSecureContext) return false;
    if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (_) { return false; }
}

export async function biometricEnabled() {
  const s = await getSecurity();
  return !!(s.biometric && s.biometric.credentialId);
}

export async function enableBiometric() {
  if (!(await biometricAvailable())) {
    throw new Error('Este dispositivo ou navegador não oferece biometria para aplicativos web.');
  }
  const s = await getSecurity();
  if (!s.enabled) throw new Error('Configure um PIN antes de ativar a biometria.');

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Overall Finanças', id: location.hostname },
      user: { id: userId, name: 'usuario-local', displayName: 'Usuário' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      attestation: 'none'
    }
  });
  if (!cred) throw new Error('Não foi possível registrar a biometria.');
  s.biometric = { credentialId: toB64(cred.rawId), createdAt: nowTs() };
  await setRawSetting(KEY, s);
  log('security.biometric.enabled');
  return true;
}

export async function disableBiometric() {
  const s = await getSecurity();
  s.biometric = null;
  await setRawSetting(KEY, s);
  log('security.biometric.disabled');
  return true;
}

export async function unlockWithBiometric() {
  const s = await getSecurity();
  if (!s.biometric || !s.biometric.credentialId) return false;
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromB64(s.biometric.credentialId) }],
        userVerification: 'required',
        timeout: 60000,
        rpId: location.hostname
      }
    });
    if (!assertion) return false;
    s.attempts = 0;
    await setRawSetting(KEY, s);
    unlock();
    log('security.unlock.biometric');
    return true;
  } catch (e) {
    logWarn('security.biometric.fail', { name: e && e.name });
    return false;
  }
}

/* --------------------------- Estado de bloqueio -------------------------- */

let lockedNow = false;
let idleTimer = null;
let onLockCb = null;
let autoLockMinutesCache = 5;

export function onLock(cb) { onLockCb = cb; }

function sessionUnlockedUntil() {
  try {
    const v = sessionStorage.getItem(SESSION_KEY);
    return v ? Number(v) : 0;
  } catch (_) { return 0; }
}
function writeSession(untilTs) {
  try {
    if (untilTs) sessionStorage.setItem(SESSION_KEY, String(untilTs));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}

export function isLocked() { return lockedNow; }

export function unlock() {
  lockedNow = false;
  const minutes = autoLockMinutesCache;
  writeSession(minutes > 0 ? nowTs() + minutes * 60000 : nowTs() + 12 * 3600000);
  restartIdleTimer();
}

export function lock() {
  lockedNow = true;
  writeSession(0);
  clearTimeout(idleTimer);
  if (onLockCb) { try { onLockCb(); } catch (e) { logError('security.onLock', e); } }
}

function restartIdleTimer() {
  clearTimeout(idleTimer);
  if (!lockedNow && autoLockMinutesCache > 0) {
    idleTimer = setTimeout(() => { if (!lockedNow) { log('security.autolock'); lock(); } }, autoLockMinutesCache * 60000);
    writeSession(nowTs() + autoLockMinutesCache * 60000);
  }
}

/** Chamado no boot: decide se a tela de bloqueio aparece. */
export async function initLockState() {
  const s = await getSecurity();
  autoLockMinutesCache = s.autoLockMinutes ?? 5;
  if (!s.enabled || !s.hashValue) { lockedNow = false; return false; }

  const until = sessionUnlockedUntil();
  if (until && nowTs() < until) { lockedNow = false; restartIdleTimer(); return false; }
  lockedNow = true;
  return true;
}

/** Monitora inatividade e volta de segundo plano. */
export function watchActivity() {
  const bump = () => { if (!lockedNow) restartIdleTimer(); };
  ['pointerdown', 'keydown', 'touchstart', 'focus'].forEach((ev) =>
    window.addEventListener(ev, bump, { passive: true })
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const until = sessionUnlockedUntil();
      if (!lockedNow && until && nowTs() > until) lock();
      else bump();
    }
  });
}

export function currentAutoLockMinutes() { return autoLockMinutesCache; }
export function setAutoLockCache(v) { autoLockMinutesCache = v; restartIdleTimer(); }
