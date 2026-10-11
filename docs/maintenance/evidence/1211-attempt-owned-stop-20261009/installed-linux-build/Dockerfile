FROM meridian1211:checkpoint-r6-corrected-tagged
USER root
RUN mkdir -p /opt/e71/packs /opt/e71/installed && chown -R 501:501 /opt/e71/packs /opt/e71/installed
USER meridianfixture
WORKDIR /opt/e71/candidate
RUN npm pack --ignore-scripts --json --pack-destination /opt/e71/packs > /opt/e71/packs/PACK.json
RUN npm install --prefix /opt/e71/installed --ignore-scripts --no-audit --no-fund /opt/e71/packs/rynfar-meridian-1.80.0.tgz && node /opt/e71/installed/node_modules/@anthropic-ai/claude-code/install.cjs
RUN node -e "const fs=require('fs'),crypto=require('crypto');const root='/opt/e71/installed/node_modules/';const r={sdkVersion:require(root+'@anthropic-ai/claude-agent-sdk/package.json').version,nativeVersion:require(root+'@anthropic-ai/claude-code/package.json').version,meridianVersion:require(root+'@rynfar/meridian/package.json').version,tarballSHA256:crypto.createHash('sha256').update(fs.readFileSync('/opt/e71/packs/rynfar-meridian-1.80.0.tgz')).digest('hex')};fs.writeFileSync('/opt/e71/INSTALLED_IDENTITY.json',JSON.stringify(r)+'\n');console.log('INSTALLED_IDENTITY:'+JSON.stringify(r));"
