FROM meridian1211:checkpoint-r6-44ae1bc2-complete
USER root
COPY --chown=501:501 candidate/ /opt/e71/candidate/
USER meridianfixture
WORKDIR /opt/e71/candidate
RUN npm run build
