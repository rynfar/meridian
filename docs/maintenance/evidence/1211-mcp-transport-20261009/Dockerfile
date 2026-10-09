FROM meridian1211-e41:20261009-r11
USER root
RUN rm -rf /opt/e71/candidate /opt/e41-package && mkdir /opt/e71/candidate /opt/e41-package && chown 501:501 /opt/e71/candidate /opt/e41-package
COPY --chown=501:501 candidate/ /opt/e71/candidate/
USER meridianfixture
WORKDIR /opt/e71/candidate
RUN bun install --frozen-lockfile --ignore-scripts && node node_modules/@anthropic-ai/claude-code/install.cjs && test -z "$(git status --porcelain)" && npm run build
RUN npm pack --ignore-scripts --pack-destination /opt/e41-package
WORKDIR /opt/e41-package
RUN npm install --prefix /opt/e41-package/installed --ignore-scripts --no-audit --no-fund /opt/e41-package/rynfar-meridian-1.80.0.tgz && npm install --prefix /opt/e41-package/installed --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-agent-sdk@0.2.141 @anthropic-ai/claude-code@2.1.295 && node /opt/e41-package/installed/node_modules/@anthropic-ai/claude-code/install.cjs
WORKDIR /opt/e71/candidate
