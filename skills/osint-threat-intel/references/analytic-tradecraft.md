# Analytic Tradecraft — principes de réflexion multi-sources

Ces principes viennent du renseignement classique (analyse de sources
ouvertes, tradecraft OTAN/militaire adapté au civil) et s'appliquent à
chaque enquête, pas seulement aux cas complexes. L'objectif : ne jamais
traiter une info single-source comme un fait établi, et rendre le niveau de
confiance explicite plutôt qu'implicite.

## Admiralty Code (grille de fiabilité / crédibilité)

Deux échelles indépendantes, toujours notées ensemble (ex: `B2`) :

**Fiabilité de la source** (l'émetteur, pas l'info elle-même)
| Code | Sens |
|---|---|
| A | Totalement fiable (source primaire, vérifiée historiquement) |
| B | Habituellement fiable |
| C | Assez fiable |
| D | Pas toujours fiable |
| E | Non fiable |
| F | Fiabilité impossible à juger |

**Crédibilité de l'information** (le contenu, indépendamment de la source)
| Code | Sens |
|---|---|
| 1 | Confirmé par d'autres sources indépendantes |
| 2 | Probablement vrai |
| 3 | Possiblement vrai |
| 4 | Douteux |
| 5 | Improbable |
| 6 | Crédibilité impossible à juger |

Utiliser cette grille dans le `thinking` et dans le rapport final plutôt que
des mots vagues ("il semblerait que", "apparemment") — un code `B2` ou `F6`
dit exactement ce que ça vaut.

## Triangulation

Une affirmation basée sur une seule source reste une **piste**, pas un
**fait**, quelle que soit la réputation de la source. Avant de présenter
quelque chose comme établi :

1. Chercher au moins une deuxième source **indépendante** (pas un simple
   repost/citation de la première).
2. Vérifier que les sources ne partagent pas la même origine première
   (deux articles qui citent tous les deux le même tweet ne sont pas deux
   sources indépendantes).
3. Si une seule source existe malgré la recherche, le dire explicitement :
   "non corroboré, source unique (grade X)" plutôt que de le présenter au
   même niveau qu'une info triangulée.

## Primaire vs secondaire

Préférer et signaler la source primaire (le certificat SSL lui-même, le
post original, le résultat brut du scan) plutôt qu'un résumé qui en est
fait ailleurs. Une source secondaire peut introduire une erreur de
transcription ou une interprétation — la source primaire ne ment pas de
cette façon-là (elle peut mentir autrement, mais pas par transcription).

## Biais de confirmation — chercher activement le contraire

Une fois qu'une hypothèse commence à se former, chercher spécifiquement ce
qui la contredirait, pas seulement ce qui la confirme. Concrètement : si
l'hypothèse est "ce domaine appartient au groupe X", chercher aussi
"qu'est-ce qui suggérerait que ce n'est PAS le groupe X" avant de conclure.

## Regroupement / clustering

Quand plusieurs indicateurs sont réunis (IOCs, sous-domaines, handles),
les regrouper par ce qu'ils ont réellement en commun (même IP, même
certificat, même pattern d'enregistrement, même infra d'hébergement) plutôt
que de les lister à plat. Un cluster avec un lien technique concret est une
trouvaille ; une liste d'indicateurs juxtaposés sans lien démontré n'en est
pas une — ne pas présenter l'un comme l'autre.

## Distinguer analyse et fait

Toujours séparer, y compris dans le style d'écriture : "la source dit X"
(fait rapporté) vs "je pense que Y en découle" (analyse). Ne pas laisser une
inférence se lire comme si elle était elle-même une source.
