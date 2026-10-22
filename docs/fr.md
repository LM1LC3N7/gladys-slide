# Rideaux Slide

Cette intégration relie Gladys à **vos moteurs de rideaux Slide** (Innovation in
Motion) par leur **API locale**. Chaque Slide devient un **rideau** dans
l'onglet **Découverte** de Gladys : ouverture, fermeture, arrêt, position, et un
bouton de calibrage. Tout reste sur votre réseau local : le cloud de Slide n'est
pas utilisé. Non officiel, sans lien avec Innovation in Motion.

> **Version de développement (0.1).** Écrite d'après l'API locale publiée par le
> fabricant et la bibliothèque goslide-api, et testée contre des Slides simulés
> seulement : elle n'a **jamais été testée avec un vrai Slide** pour l'instant.
> Vos retours sont les bienvenus sur le dépôt GitHub.

## Ce que vous obtenez

| Fonctionnalité        | Dans Gladys                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| Ouverture / fermeture | ouvrir, fermer, **arrêter** le rideau                                              |
| Position              | 0 % = fermé, 100 % = ouvert ; lue à l'intervalle choisi, et pilotable              |
| Calibrer              | un bouton qui lance le calibrage du Slide, **désactivé par défaut** (voir Options) |

Le Slide n'est **jamais** un interrupteur : une scène « tout éteindre » ne le
ferme pas. Il est classé « rideau » : un « ferme les rideaux » d'une scène, de
Google, d'Alexa, de HomeKit ou d'un assistant (MCP) le ferme, comme attendu.

## Prérequis

- Un ou plusieurs Slides sur le même réseau local que Gladys, avec leur **API
  locale activée** dans l'application Slide.
- L'adresse IP de chaque Slide, de préférence fixe (réservée dans votre box
  internet).
- Pour un Slide au micrologiciel ancien (**API v1**) : son **code d'appareil**
  de 8 caractères, imprimé sur le Slide. Les Slides récents (**API v2**) n'ont
  pas de mot de passe : n'importe qui sur votre réseau peut s'en servir, avec ou
  sans Gladys. Gardez-les sur un réseau de confiance.

## Installation

1. Dans Gladys, ouvrez l'intégration **Rideaux Slide**, onglet
   **Configuration**.
2. Saisissez les **adresses** de vos Slides, séparées par des virgules (8 au
   plus), par exemple `192.168.1.40, 192.168.1.41`.
3. Seulement pour des Slides en API v1 : saisissez leurs **codes**, dans le
   **même ordre** que les adresses, séparés par des virgules ; laissez la place
   vide pour un Slide en API v2. Par exemple, avec les adresses ci-dessus et un
   seul Slide en API v1 (le second) : `,ABCD1234`. Ce champ est gardé par
   Gladys dans sa base, jamais réaffiché, et le code n'est envoyé qu'à ce Slide
   sur votre réseau.
4. Enregistrez, puis cliquez sur **Tester la connexion** : l'état de chaque
   Slide s'affiche.
5. Ouvrez l'onglet **Découverte** et ajoutez vos Slides.

## Options

- **Intervalle de lecture** (30 s par défaut, 10 à 3600 s) : fréquence de
  lecture de la position de chaque Slide. Après une commande, le Slide est aussi
  relu quelques fois pendant que le rideau bouge (2, 8, 20 et 45 s).
- **Autoriser le calibrage** (désactivé par défaut) : le bouton « Calibrer »
  fait aller le rideau d'un bout à l'autre pour réapprendre sa course. Tant que
  l'option est désactivée, le bouton est refusé ; elle est relue juste avant
  l'envoi.
- **Langue des noms des fonctionnalités** : français ou anglais.

## Comment les commandes sont envoyées

- **Ouvrir, fermer, une position, calibrer** : Gladys lit d'abord l'identité
  (adresse MAC) du Slide à cette adresse. Si un autre Slide y répond (une
  adresse donnée à un autre par votre box), la commande est refusée sans rien
  envoyer. La commande part en moins de 3,5 s, ou elle est refusée.
- **Arrêter** part toujours tout de suite : sans attendre, même pendant une
  pause demandée par le Slide, et même juste après un redémarrage de
  l'intégration. Il annule les mouvements de ce Slide pas encore envoyés.
- Une commande qui a pu partir sans réponse claire est annoncée « envoyée, sans
  confirmation », et le Slide est relu ; jamais renvoyée d'elle-même.
- Une position n'est **confirmée** que par une lecture égale à la position
  demandée. Si le rideau ne l'atteint pas (un obstacle, une main sur le rideau),
  le badge du Slide passe à l'orange.

## Sécurité et vie privée

- Gladys ne parle qu'aux adresses saisies, en HTTP simple sur votre réseau
  local ; les redirections ne sont jamais suivies, aucun cloud n'est utilisé.
- Les codes d'appareil ne sont jamais écrits dans les journaux, dans `/data` ni
  dans un message. Un code refusé arrête ce Slide pour de bon : Gladys ne le
  réessaie jamais d'elle-même. Corrigez le code puis enregistrez, ou appuyez sur
  **Tester la connexion** pour un seul nouvel essai.
- Un « 429 » ou une erreur serveur d'un Slide le met en pause (1 minute à
  6 heures), et la pause survit à un redémarrage. Après un échec, Gladys
  n'interroge jamais un Slide plus souvent que l'intervalle de lecture.

## Dépannage

- **« Injoignable »** : vérifiez l'adresse IP (pas de nom en `.local`, le
  conteneur ne les résout pas), le Wi-Fi du Slide, et que son API locale est
  activée.
- **« Demande son code d'appareil »** : ce Slide est en API v1 ; saisissez son
  code à la même place dans la liste que son adresse.
- **« Introuvable aux adresses saisies »** : l'adresse d'un Slide a changé ;
  saisissez la nouvelle, son appareil et son historique sont gardés.
- **Position inversée** : dites-le-nous sur le dépôt GitHub.

## Crédits

Logique reprise de [goslide-api](https://github.com/ualex73/goslide-api)
(Apache-2.0), la bibliothèque de l'intégration Slide de Home Assistant. Slide
est une marque d'Innovation in Motion ; ce projet est sans lien avec Innovation
in Motion.
