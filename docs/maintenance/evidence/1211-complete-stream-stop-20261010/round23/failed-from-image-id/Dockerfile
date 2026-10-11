FROM sha256:98bcf4655603115bf8808376120003aeb385c2dc144bcadd60958c898fa740f0
USER root
COPY candidate.bundle SOURCE_IDENTITY.json qualify-source.py /snapshot-corrected/
RUN git init /opt/e71/corrected && git -C /opt/e71/corrected bundle unbundle /snapshot-corrected/candidate.bundle && git -C /opt/e71/corrected symbolic-ref HEAD refs/heads/codex/claude-sidecalls-stack-1292-20261008 && git -C /opt/e71/corrected update-ref HEAD 34b49d82d9f69b1044ccca2d12a082eca05969ca && chown -R 501:501 /opt/e71/corrected && mkdir -p /opt/e71/corrected-packs /opt/e71/corrected-installed && chown -R 501:501 /opt/e71/corrected-packs /opt/e71/corrected-installed
COPY --chown=501:501 candidate/ /opt/e71/corrected/
USER meridianfixture
WORKDIR /opt/e71/corrected
RUN cp -a /opt/e71/current/node_modules node_modules && python3 /snapshot-corrected/qualify-source.py && npm run build
RUN npm pack --ignore-scripts --json --pack-destination /opt/e71/corrected-packs > /opt/e71/corrected-packs/PACK.json && npm install --prefix /opt/e71/corrected-installed --ignore-scripts --no-audit --no-fund /opt/e71/corrected-packs/rynfar-meridian-1.80.0.tgz && npm install --prefix /opt/e71/corrected-installed --ignore-scripts --no-audit --no-fund --save-exact @anthropic-ai/claude-agent-sdk@0.2.141 @anthropic-ai/claude-code@2.1.296 && node /opt/e71/corrected-installed/node_modules/@anthropic-ai/claude-code/install.cjs
COPY --chown=501:501 qualify-build.cjs /snapshot-corrected/
RUN node /snapshot-corrected/qualify-build.cjs
