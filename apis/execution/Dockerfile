FROM ubuntu:26.04

# Install Node.js via NodeSource (bundles npm) + all other runtimes
# Also reduces image size
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y \
        python3 \
        ruby \
        ruby-irb \
        nodejs \
        postgresql \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ts-node for interactive REPL and one-off, since tsx doesn't have repl
# pin TypeScript to ^5 since ts-node v10 doesn't support TS 7+
RUN npm install -g ts-node 'typescript@^5'

# Add a tsconfig.json 
RUN echo '{"compilerOptions":{"module":"CommonJS"}}' > /tsconfig.json

# Allow all local PostgreSQL connections without password (peer -> trust)
RUN sed -i 's/local   all             all                                     peer/local   all             all                                     trust/' /etc/postgresql/18/main/pg_hba.conf

# Keep container alive so exec subprocesses can run alongside bash
CMD ["/bin/bash"]