FROM ubuntu:24.04

# Install Node.js via NodeSource (bundles npm) + all other runtimes
# Also reduces image size
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y \
        python3 \
        ruby \
        ruby-irb \
        nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install TypeScript REPL via tsx (faster than ts-node, works cleanly with Node 22)
RUN npm install -g tsx

# Keep container alive so exec subprocesses can run alongside bash
CMD ["/bin/bash"]