FROM --platform=linux/amd64 python:3.12-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

EXPOSE 8080

# Single worker: in-memory state (dedup set, Snowpipe channel) is not safe
# to share across multiple workers. For demo-scale traffic this is sufficient.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
