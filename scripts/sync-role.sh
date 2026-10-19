#!/usr/bin/env bash
# Copia el rol desde el directorio de trabajo personal al repositorio.
#
#   scripts/sync-role.sh            # ~/Apolo/RPG/Universal_Tutor_Project_v4_mini.md -> roles/Universal_Tutor_Project.md
#   scripts/sync-role.sh <archivo>  # otro archivo de rol como origen
#
# Después de sincronizar: revisar CHANGELOG.md, subir "version" en package.json
# y hacer commit con un mensaje que resuma el cambio del prompt.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGEN="${1:-$HOME/Apolo/RPG/Universal_Tutor_Project_v4_mini.md}"
DESTINO="$REPO_DIR/roles/Universal_Tutor_Project.md"

if [[ ! -f "$ORIGEN" ]]; then
	echo "No existe el archivo de origen: $ORIGEN" >&2
	exit 1
fi

cp -- "$ORIGEN" "$DESTINO"
echo "Rol sincronizado:"
echo "  origen   → $ORIGEN"
echo "  destino  → $DESTINO"
echo "  $(wc -l < "$DESTINO") líneas, $(wc -c < "$DESTINO") bytes"
