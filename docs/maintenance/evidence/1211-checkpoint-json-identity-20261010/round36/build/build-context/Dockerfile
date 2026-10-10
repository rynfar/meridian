FROM meridian1211:complete-stream-r23-corrected
USER root
COPY candidate.bundle SOURCE_IDENTITY.json qualify-source.py /snapshot-json/
RUN git init /opt/e71/json-corrected && git -C /opt/e71/json-corrected bundle unbundle /snapshot-json/candidate.bundle && git -C /opt/e71/json-corrected symbolic-ref HEAD refs/heads/codex/claude-sidecalls-stack-1292-20261008 && git -C /opt/e71/json-corrected update-ref HEAD ee3671ee8ee8f5b92321b5f559e7aa02fdc9accf && chown -R 501:501 /opt/e71/json-corrected && mkdir -p /opt/e71/json-corrected-packs /opt/e71/json-corrected-installed && chown -R 501:501 /opt/e71/json-corrected-packs /opt/e71/json-corrected-installed
COPY --chown=501:501 candidate/ /opt/e71/json-corrected/
USER meridianfixture
WORKDIR /opt/e71/json-corrected
RUN cp -a /opt/e71/corrected/node_modules node_modules && python3 /snapshot-json/qualify-source.py && npm run build
RUN npm pack --ignore-scripts --json --pack-destination /opt/e71/json-corrected-packs > /opt/e71/json-corrected-packs/PACK.json && npm install --prefix /opt/e71/json-corrected-installed --ignore-scripts --no-audit --no-fund /opt/e71/json-corrected-packs/rynfar-meridian-1.80.0.tgz && npm install --prefix /opt/e71/json-corrected-installed --ignore-scripts --no-audit --no-fund --save-exact @anthropic-ai/claude-agent-sdk@0.2.141 @anthropic-ai/claude-code@2.1.296 && node /opt/e71/json-corrected-installed/node_modules/@anthropic-ai/claude-code/install.cjs
COPY --chown=501:501 qualify-build.cjs /snapshot-json/
RUN node /snapshot-json/qualify-build.cjs
