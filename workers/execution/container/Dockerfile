FROM ubuntu:26.04

# Install Node.js via NodeSource (bundles npm) + all other runtimes
# Also reduces image size
RUN apt-get update && apt-get install -y curl build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y \
        python3 \
        ruby \
        ruby-irb \
        nodejs \
        postgresql \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Allow all local PostgreSQL connections without password (peer -> trust)
RUN sed -i 's/local   all             all                                     peer/local   all             all                                     trust/' /etc/postgresql/18/main/pg_hba.conf

# Set PostgreSQL shared buffer size to 32mb to avoid wasting memory for our smaller use case.
# Disable TCP listening entirely since psql connects via Unix socket within the container.
# Disable SSL — we only use local Unix sockets, so TLS and the snakeoil cert are unnecessary.
# Use mmap for dynamic shared memory: Cloudflare Containers have no usable /dev/shm,
# so the default posix type fails with "could not open shared memory segment".
RUN echo "shared_buffers = 32MB" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "listen_addresses = ''" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "ssl = off" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "dynamic_shared_memory_type = mmap" >> /etc/postgresql/18/main/postgresql.conf

# Trim the rest of Postgres's default memory footprint for this single-user,
# throwaway-database use case. Containers run on the "lite" instance type
# (256MB total RAM shared with Node + the active language REPL), so every
# default sized for a normal server is worth cutting down here:
#  - max_connections: only ever one psql client at a time, not the default 100,
#    which shrinks several shared-memory structures sized off this value
#    (lock table, PGPROC array, snapshot arrays).
#  - work_mem / maintenance_work_mem: cap per-query and VACUUM/CREATE INDEX
#    memory spikes well below their 4MB/64MB defaults.
#  - autovacuum: studentdb only lives for a single pad session (dropped and
#    recreated the first time SQL is used), so it's never around long enough
#    to need background vacuuming.
#  - max_worker_processes / max_parallel_workers(_per_gather): no parallel
#    query benefit on these tiny tables, so don't reserve the slots.
#  - max_wal_senders / max_replication_slots: replication is never used; this
#    also skips starting the logical replication launcher background process.
#  - effective_cache_size: the 4GB default is nonsensical on a 256MB
#    container and can mislead the planner.
RUN echo "max_connections = 10" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "work_mem = 2MB" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "maintenance_work_mem = 16MB" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "effective_cache_size = 32MB" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "autovacuum = off" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "max_worker_processes = 4" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "max_parallel_workers = 0" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "max_parallel_workers_per_gather = 0" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "max_wal_senders = 0" >> /etc/postgresql/18/main/postgresql.conf \
    && echo "max_replication_slots = 0" >> /etc/postgresql/18/main/postgresql.conf

# Create a dedicated user. Run the container as that user
RUN useradd -m -s /bin/bash sandbox

# Set up a working directory
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production
COPY server.js ./
COPY pty.js ./
EXPOSE 8080

# Start the Node server
CMD ["node", "/app/server.js"]