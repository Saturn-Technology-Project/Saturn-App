# Saturn: pinned by digest (OpenSSF Scorecard, Pinned-Dependencies); update the digest with the tag.
FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm@sha256:973037be1c64ff7f0b9409ae136fd7fe83718b2af30e8872ba11ac69a422eb9b

ADD install-vscode.sh /root/
RUN /root/install-vscode.sh

RUN git config --system codespaces-theme.hide-status 1

USER node
RUN npm install -g node-gyp
RUN NPM_CACHE="$(npm config get cache)" && rm -rf "$NPM_CACHE" && ln -s /vscode-dev/npm-cache "$NPM_CACHE"
RUN echo 'export DISPLAY="${DISPLAY:-:1}"' | tee -a ~/.bashrc >> ~/.zshrc

USER root
CMD chown node:node /vscode-dev && sudo -u node mkdir -p /vscode-dev/npm-cache && sleep inf
