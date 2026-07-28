"""
Local development server for dashboard.html iteration.
Mocks all /api/* endpoints and serves /static/* files.
Run: python3 dev-server.py
Open: http://localhost:8080/static/dashboard.html
"""
import json
import math
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

STATIC_DIR = Path(__file__).parent / "static"

# ---------------------------------------------------------------------------
# Mock API responses — edit these to test different states
# ---------------------------------------------------------------------------
MOCK_RESULTS = {
    "active": True,
    "question_id": "test-001",
    "question_text": "What is your favorite Snowflake feature?",
    "context_text": "Choose the feature that excites you most",
    "options": [
        {"option_text": "Snowpipe Streaming",  "display_order": 1, "vote_count": 42, "vote_pct": 38.9},
        {"option_text": "Interactive Tables",  "display_order": 2, "vote_count": 35, "vote_pct": 32.4},
        {"option_text": "Cortex AI",           "display_order": 3, "vote_count": 21, "vote_pct": 19.4},
        {"option_text": "Snowpark",            "display_order": 4, "vote_count": 10, "vote_pct": 9.3},
    ],
    "total_votes": 108,
    "votes_per_sec": 2.3,
    "freshness_ms": 487,
    "query_ms": 12,
}

MOCK_VOTERS = {
    "active": True,
    "question_id": "test-001",
    "total_unique_voters": 74,
    "countries": [
        {"country": "US", "count": 45},
        {"country": "GB", "count": 12},
        {"country": "DE", "count": 8},
        {"country": "CA", "count": 5},
        {"country": "AU", "count": 4},
    ],
    "points": [
        {"lat": 37.77,  "lng": -122.41, "city": "San Francisco",  "region": "California",      "country": "US", "count": 12},
        {"lat": 40.71,  "lng": -74.00,  "city": "New York",        "region": "New York",         "country": "US", "count": 8},
        {"lat": 47.13,  "lng": -119.28, "city": "Moses Lake",      "region": "Washington",       "country": "US", "count": 3},
        {"lat": 51.51,  "lng": -0.13,   "city": "London",          "region": "England",          "country": "GB", "count": 12},
        {"lat": 52.52,  "lng": 13.40,   "city": "Berlin",          "region": "Berlin",           "country": "DE", "count": 8},
        {"lat": 43.65,  "lng": -79.38,  "city": "Toronto",         "region": "Ontario",          "country": "CA", "count": 5},
        {"lat": -33.87, "lng": 151.21,  "city": "Sydney",          "region": "New South Wales",  "country": "AU", "count": 4},
        {"lat": 35.69,  "lng": 139.69,  "city": "Tokyo",           "region": "Tokyo",            "country": "JP", "count": 3},
        {"lat": 1.35,   "lng": 103.82,  "city": "Singapore",       "region": "Singapore",        "country": "SG", "count": 2},
        {"lat": 28.61,  "lng": 77.21,   "city": "New Delhi",       "region": "Delhi",            "country": "IN", "count": 2},
        {"lat": -23.55, "lng": -46.63,  "city": "São Paulo",       "region": "São Paulo",        "country": "BR", "count": 3},
        {"lat": 48.85,  "lng": 2.35,    "city": "Paris",           "region": "Île-de-France",    "country": "FR", "count": 4},
        {"lat": 55.75,  "lng": 37.62,   "city": "Moscow",          "region": "Moscow",           "country": "RU", "count": 2},
        {"lat": -34.61, "lng": -58.38,  "city": "Buenos Aires",    "region": "Buenos Aires",     "country": "AR", "count": 1},
        {"lat": 19.43,  "lng": -99.13,  "city": "Mexico City",     "region": "CDMX",             "country": "MX", "count": 3},
    ],
    "devices": {"mobile": 51, "desktop": 20, "tablet": 3},
}

MOCK_COMPARE = {
    "interactive": {"warehouse": "DEMO_IWT_WH", "elapsed_ms": 8},
    "standard":    {"warehouse": "DEMO_STD_WH", "elapsed_ms": 247},
    "errors": None,
}

MOCK_CONFIG = {
    "public_vote_url": "https://demo-predictions-worker.jtaosandbox.workers.dev",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default logging

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path

        # API routes
        if path == "/api/results":
            # Slightly vary votes to simulate live updates
            d = dict(MOCK_RESULTS)
            d["query_ms"] = 8 + int(time.time() * 7) % 15
            return self.send_json(d)

        if path == "/api/voters":
            return self.send_json(MOCK_VOTERS)

        if path == "/api/compare":
            return self.send_json(MOCK_COMPARE)

        if path == "/api/config":
            return self.send_json(MOCK_CONFIG)

        if path == "/api/active":
            return self.send_json({"active": True})

        # Static files
        if path.startswith("/static/"):
            file_path = STATIC_DIR / path[len("/static/"):]
            if file_path.exists() and file_path.is_file():
                body = file_path.read_bytes()
                mime = {
                    ".js":      "application/javascript",
                    ".css":     "text/css",
                    ".html":    "text/html",
                    ".json":    "application/json",
                    ".geojson": "application/json",
                    ".png":     "image/png",
                }.get(file_path.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()
            return

        # Serve dashboard.html for root and /dashboard
        if path in ("/", "/dashboard"):
            body = (STATIC_DIR / "dashboard.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 8080), Handler)
    print("Dev server running at http://localhost:8080/dashboard")
    print("Edit static/dashboard.html and refresh — no rebuild needed.")
    print("Ctrl+C to stop.")
    server.serve_forever()
