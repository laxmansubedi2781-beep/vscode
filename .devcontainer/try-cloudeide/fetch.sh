#!/usr/bin/env bash
# Installs what Electron needs and puts the last built CloudeIDE on the desktop.
#
# Run once, when the Codespace is created. Everything it downloads comes from
# this repository's own workflow runs, using the token the Codespace already
# holds.
set -euo pipefail

echo "--- libraries Electron expects on a desktop, which a base image omits ---"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
	libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
	libgtk-3-0 libasound2 libxkbfile1 libsecret-1-0 xdg-utils

repo="${GITHUB_REPOSITORY:-laxmansubedi7/cloudevs}"

echo "--- the most recent run of the desktop workflow that finished green ---"
run="$(gh run list --repo "$repo" --workflow desktop.yml --status success \
	--limit 1 --json databaseId --jq '.[0].databaseId')"
if [ -z "$run" ]; then
	echo "No successful desktop build to download yet. Run the 'Desktop app'"
	echo "workflow, then re-run: ./.devcontainer/try-cloudeide/fetch.sh"
	exit 0
fi
echo "run ${run}"

rm -rf ~/dl && mkdir -p ~/dl
gh run download "$run" --repo "$repo" --name cloudeide-linux-x64 --dir ~/dl

echo "--- unpacking ---"
tar -xzf ~/dl/*.tar.gz -C ~
rm -rf ~/dl
test -x ~/VSCode-linux-x64/cloudeide

# Fluxbox reads this at startup; without it the desktop is an empty grey field
# with no obvious way in.
mkdir -p ~/Desktop
cat > ~/Desktop/CloudeIDE.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=CloudeIDE
Exec=/home/vscode/VSCode-linux-x64/cloudeide --no-sandbox --disable-gpu
Terminal=false
DESKTOP
chmod +x ~/Desktop/CloudeIDE.desktop

# And a one-word way to start it from a terminal, for whoever prefers that.
sudo ln -sf ~/VSCode-linux-x64/cloudeide /usr/local/bin/cloudeide

cat <<'DONE'

CloudeIDE is unpacked at ~/VSCode-linux-x64.

Open the forwarded port 6080 in a browser — phone included — and the
desktop appears. Start the application by typing `cloudeide` in a
terminal here, or by clicking CloudeIDE on that desktop.
DONE
