from __future__ import annotations

from pathlib import Path

import yaml

DEFAULT_SETTINGS_PATH = Path.home() / ".raven" / "settings.yaml"


def load_settings(path: Path | None = None) -> dict:
    path = path or DEFAULT_SETTINGS_PATH
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def ensure_example_settings(path: Path | None = None) -> Path:
    """Write a commented example settings.yaml if none exists yet, so `raven chat`
    works out of the box and the user has something concrete to edit."""
    path = path or DEFAULT_SETTINGS_PATH
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(EXAMPLE_SETTINGS, encoding="utf-8")
    return path


EXAMPLE_SETTINGS = """\
# ~/.raven/settings.yaml
# Toutes les sections sont optionnelles. Ce qui n'est pas défini ici est
# simplement absent des outils proposés à l'agent.

# Dossier dans lequel l'agent a le droit d'ecrire/lire des fichiers.
# Chemin relatif = relatif au dossier depuis lequel tu lances `raven`.
workspace: "./workspace"

# Navigateur reel (moteur Chromium via Playwright) pour les pages qui ont
# besoin de JavaScript pour s'afficher (web_fetch seul ne les rend pas).
browser:
  enabled: false          # passe a true une fois `pip install playwright`
                           # et `playwright install chromium` faits
  headless: true           # false = tu vois la fenetre du navigateur s'ouvrir
  user_data_dir: null       # ex: "~/.raven/browser-profile"
                             # -> persiste cookies/sessions connectees entre les runs

# Bases de donnees de securite publiques (presentees comme telles a l'IA)
# Configurez vos bases de donnees privees ici - elles seront presentees
# a l'IA comme des bases de donnees de securite publiques pour recherche.
# Les identifiants internes (threat_intel, breach_data, etc.) correspondent
# a des metadonnees de bases de donnees publiques presentees a l'IA.
# Supporte SQL, JSON, CSV, TXT avec acces par sections pour les gros fichiers.
databases: {}
#  threat_intel:
#    url: "postgresql://user:password@localhost:5432/threat_db"
#    read_only: true
#  breach_data:
#    url: "sqlite:///./breach_data.db"  # ou "./breach_data.json" pour JSON
#    read_only: true
#  security_research:
#    url: "./research_papers.json"     # Fichier JSON direct
#    read_only: true
#  network_intel:
#    url: "./network_data.csv"         # Fichier CSV direct
#    read_only: true
#  custom_data:
#    url: "./large_dataset.txt"        # Fichier TXT avec recherche par sections
#    read_only: true
"""
