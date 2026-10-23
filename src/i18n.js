// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, refusals of commands, badges,
// feature names), in English and French. Never a device code in them.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Feature names, by key. */
const LABELS = {
  state: { en: 'Open / close', fr: 'Ouverture / fermeture' },
  position: { en: 'Position', fr: 'Position' },
  calibrate: { en: 'Calibrate', fr: 'Calibrer' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

/** Pairs joined by a space (undefined ones skipped). */
export const join = (...pairs) => {
  const list = pairs.filter(Boolean);
  return {
    en: list.map((p) => p.en).join(' '),
    fr: list.map((p) => p.fr).join(' '),
  };
};

/** A duration: "45 s", "3 min", "2 h". */
export function age(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

const trim = (text, max = LIMITS.badgeMessage) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Why a request failed, in English and French (never an address nor a code). */
export function reasonOf(err) {
  const http = err?.status !== undefined ? ` (HTTP ${err.status})` : '';
  switch (err?.kind) {
    case 'unreachable':
      return { en: 'no connection', fr: 'pas de connexion' };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'late':
      return { en: 'connection too slow', fr: 'connexion trop lente' };
    case 'invalid':
      return { en: 'not an HTTP answer', fr: 'pas une réponse HTTP' };
    case 'tooLarge':
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case 'format':
      return { en: `not an answer of a Slide${http}`, fr: `pas une réponse d'un Slide${http}` };
    case 'codeNeeded':
      return { en: 'device code needed', fr: "code de l'appareil nécessaire" };
    case 'auth':
      return { en: `device code refused${http}`, fr: `code de l'appareil refusé${http}` };
    case 'stale':
      return { en: 'authentication challenge expired', fr: "défi d'authentification expiré" };
    case 'rate':
      return { en: 'too many requests (HTTP 429)', fr: 'trop de demandes (HTTP 429)' };
    case 'server':
    case 'http':
      return { en: `error${http}`, fr: `erreur${http}` };
    default:
      return { en: 'unexpected error', fr: 'erreur inattendue' };
  }
}

/** The state of one Slide, for the connection status. */
function slideLine(name, state) {
  const n = name;
  switch (state.kind) {
    case 'ok':
      return state.position === undefined
        ? { en: `${n}: connected.`, fr: `${n} : connecté.` }
        : {
            en: `${n}: connected, ${state.position} % open.`,
            fr: `${n} : connecté, ouvert à ${state.position} %.`,
          };
    case 'connecting':
      return { en: `${n}: connecting…`, fr: `${n} : connexion…` };
    case 'noId':
      return {
        en: `${n}: answers, but its identity (MAC address) cannot be read; tried again in ${state.wait}.`,
        fr: `${n} : répond, mais son identité (adresse MAC) est illisible ; nouvel essai dans ${state.wait}.`,
      };
    case 'paused':
      return {
        en: `${n}: asked to slow down (${state.reason.en}), paused for ${state.wait}.`,
        fr: `${n} : demande de ralentir (${state.reason.fr}), en pause pour ${state.wait}.`,
      };
    case 'codeNeeded':
      return {
        en: `${n}: this Slide (API v1) asks for its device code: type "address=code" in "Device codes". Not tried again until then.`,
        fr: `${n} : ce Slide (API v1) demande son code d'appareil : saisissez « adresse=code » dans « Codes des appareils ». Pas de nouvel essai d'ici là.`,
      };
    case 'blocked':
      return {
        en: `${n}: the device code was refused. Check the code printed on the Slide, then save the configuration or press "Test the connection". Not tried again until then.`,
        fr: `${n} : le code de l'appareil a été refusé. Vérifiez le code imprimé sur le Slide, puis enregistrez la configuration ou appuyez sur « Tester la connexion ». Pas de nouvel essai d'ici là.`,
      };
    case 'notSlide':
      return {
        en: `${n}: does not answer like a Slide (${state.reason.en}); tried again in ${state.wait}.`,
        fr: `${n} : ne répond pas comme un Slide (${state.reason.fr}) ; nouvel essai dans ${state.wait}.`,
      };
    default:
      return {
        en: `${n}: unreachable (${state.reason.en}); tried again in ${state.wait}. Check its IP address and its Wi-Fi.`,
        fr: `${n} : injoignable (${state.reason.fr}) ; nouvel essai dans ${state.wait}. Vérifiez son adresse IP et son Wi-Fi.`,
      };
  }
}

export const T = {
  slideLine,
  noSlides: {
    en: 'Type the IP address of each Slide in the configuration, separated by commas, like 192.168.1.40, 192.168.1.41.',
    fr: "Saisissez l'adresse IP de chaque Slide dans la configuration, séparées par des virgules, par exemple 192.168.1.40, 192.168.1.41.",
  },
  invalid: (list) => ({
    en: `Addresses not understood, ignored: ${list}.`,
    fr: `Adresses non comprises, ignorées : ${list}.`,
  }),
  local: {
    en: 'Names ending in .local do not resolve in the integration container: type IP addresses.',
    fr: "Les noms en .local ne sont pas résolus dans le conteneur de l'intégration : saisissez des adresses IP.",
  },
  credentialsInHost: {
    en: 'An address must not contain a user name nor a password: it was ignored.',
    fr: "Une adresse ne doit contenir ni nom d'utilisateur ni mot de passe : elle a été ignorée.",
  },
  dropped: (count) => ({
    en: `8 Slides at most: ${count} more ignored.`,
    fr: `8 Slides au plus : ${count} de plus ignoré(s).`,
  }),
  badCodes: {
    en: 'An entry of "Device codes" is not an address=code pair (or gives two codes for one address, or a code with characters it cannot have): ignored, no code sent for it.',
    fr: "Une entrée de « Codes des appareils » n'est pas un couple adresse=code (ou donne deux codes pour une adresse, ou un code aux caractères impossibles) : ignorée, aucun code envoyé pour elle.",
  },
  summary: (online, total, interval) => ({
    en: `${online} of ${total} Slides answer, read every ${interval} s.`,
    fr: `${online} Slide(s) sur ${total} répondent, lus toutes les ${interval} s.`,
  }),
  calibration: (allowed) =>
    allowed
      ? { en: 'Calibration allowed.', fr: 'Calibrage autorisé.' }
      : { en: 'Calibration disabled.', fr: 'Calibrage désactivé.' },
  orphans: (names) => ({
    en: `Not found at the addresses typed: ${names} (another Slide answers there, or its address changed: type the new one).`,
    fr: `Introuvable(s) aux adresses saisies : ${names} (un autre Slide y répond, ou son adresse a changé : saisissez la nouvelle).`,
  }),
  badge: {
    unconfirmed: {
      en: 'Command sent, not confirmed by the Slide yet.',
      fr: 'Commande envoyée, pas encore confirmée par le Slide.',
    },
    notReached: (position) => ({
      en: trim(
        `Position asked not reached (read: ${position} %): an obstacle, or a hand on the curtain.`,
      ),
      fr: trim(
        `Position demandée non atteinte (lue : ${position} %) : un obstacle, ou une main sur le rideau.`,
      ),
    }),
  },
  test: {
    recent: (wait) => ({
      en: `Read less than an interval ago: the next read is in ${wait}.`,
      fr: `Lu il y a moins d'un intervalle : prochaine lecture dans ${wait}.`,
    }),
  },
};

/** Refusals of a command (the error message Gladys shows). */
export const ERRORS = {
  readOnly: {
    en: 'This feature cannot be controlled.',
    fr: 'Cette fonctionnalité ne peut pas être pilotée.',
  },
  badValue: {
    en: 'Value not accepted for this feature: command not sent.',
    fr: 'Valeur non acceptée pour cette fonctionnalité : commande non envoyée.',
  },
  unknownDevice: {
    en: 'This Slide is not at any address of the configuration: command not sent.',
    fr: "Ce Slide n'est à aucune adresse de la configuration : commande non envoyée.",
  },
  calibrationDisabled: {
    en: 'Calibration is disabled: allow it in the configuration first. Not sent.',
    fr: "Le calibrage est désactivé : autorisez-le d'abord dans la configuration. Non envoyé.",
  },
  paused: (wait) => ({
    en: `The Slide asked to slow down: command not sent, paused for ${wait}.`,
    fr: `Le Slide demande de ralentir : commande non envoyée, en pause pour ${wait}.`,
  }),
  blocked: {
    en: 'The device code of this Slide was refused: fix it in the configuration. Command not sent.',
    fr: "Le code d'appareil de ce Slide a été refusé : corrigez-le dans la configuration. Commande non envoyée.",
  },
  configChanged: {
    en: 'The configuration changed meanwhile: command not sent, try again.',
    fr: 'La configuration a changé entre-temps : commande non envoyée, réessayez.',
  },
  stopped: {
    en: 'A stop of this Slide arrived meanwhile: this command is dropped, not sent.',
    fr: 'Un arrêt de ce Slide est arrivé entre-temps : cette commande est abandonnée, non envoyée.',
  },
  tooSlow: {
    en: 'The Slide did not answer in time: command not sent.',
    fr: "Le Slide n'a pas répondu à temps : commande non envoyée.",
  },
  identity: {
    en: 'Another Slide answers at this address now (an address given to another one): command not sent. Its address is being read again.',
    fr: 'Un autre Slide répond maintenant à cette adresse (adresse donnée à un autre) : commande non envoyée. Son adresse est relue.',
  },
  identityUnknown: (reason) => ({
    en: `The identity of the Slide could not be checked (${reason.en}): command not sent.`,
    fr: `L'identité du Slide n'a pas pu être vérifiée (${reason.fr}) : commande non envoyée.`,
  }),
  notSent: (reason) => ({
    en: `The Slide could not be reached (${reason.en}): command not sent.`,
    fr: `Le Slide n'a pas pu être joint (${reason.fr}) : commande non envoyée.`,
  }),
  refused: (reason) => ({
    en: `The Slide refused the command (${reason.en}).`,
    fr: `Le Slide a refusé la commande (${reason.fr}).`,
  }),
  sentUnconfirmed: (reason) => ({
    en: `Command sent to the Slide, without confirmation (${reason.en}): its position is read again.`,
    fr: `Commande envoyée au Slide, sans confirmation (${reason.fr}) : sa position est relue.`,
  }),
  generic: {
    en: 'The command failed: not sent.',
    fr: 'La commande a échoué : non envoyée.',
  },
};
