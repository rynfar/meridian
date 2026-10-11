FROM sha256:23ad4ef93dc07d83f0b33f60546eef0fcc221545545b1a1b61c38eaf1f13cceb
USER root
COPY --chown=501:501 candidate/ /opt/e71/candidate/
USER meridianfixture
WORKDIR /opt/e71/candidate
RUN npm run build
