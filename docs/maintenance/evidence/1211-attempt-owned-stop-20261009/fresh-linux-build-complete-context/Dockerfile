FROM node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0
USER root
RUN groupadd -g 501 meridianfixture && useradd -u 501 -g 501 -m -s /bin/bash meridianfixture && mkdir -p /opt/e71/runtime /opt/e71/candidate /opt/e71/home /opt/e71/npm-cache && chown -R 501:501 /opt/e71
COPY --chown=501:501 candidate/ /opt/e71/candidate/
USER meridianfixture
ENV HOME=/opt/e71/home npm_config_cache=/opt/e71/npm-cache
RUN npm install --prefix /opt/e71/runtime --ignore-scripts --no-audit --no-fund --save-exact @oven/bun-linux-x64-baseline@1.3.11
ENV PATH=/opt/e71/runtime/node_modules/@oven/bun-linux-x64-baseline/bin:$PATH
WORKDIR /opt/e71/candidate
RUN bun --version && bun install --frozen-lockfile --ignore-scripts && node node_modules/@anthropic-ai/claude-code/install.cjs && node_modules/@anthropic-ai/claude-code/bin/claude.exe --version && npm run build
