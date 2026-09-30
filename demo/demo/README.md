# MetricMantis – Chaos Engineering with Docker Microservices

## 📌 Project Overview
MetricMantis is a simple microservices-based system built using Docker Compose to demonstrate **chaos engineering principles**.  
It simulates real-world distributed system behavior by intentionally introducing failures and observing system resilience.

The system consists of:
- API Service (Node.js)
- Database Service (PostgreSQL)
- Web Service (Nginx)


---

## ⚙️ Tech Stack
- Docker
- Docker Compose
- Node.js (API Layer)
- PostgreSQL (Database)
- Nginx (Web Server)

---

## 📁 Project Structure

```
demo/
├── docker-compose.yml
├── Dockerfile
├── index.js
├── package.json
├── package-lock.json
└── report.txt
```

---

## 🚀 How to Run the Project

### 1. Build and start all services
```bash
docker compose up -d --build
```

### 2. Check running containers
```bash
docker ps
```

---

## 🧪 Chaos Engineering Experiment

### Step 1: Run system normally
All services (API, DB, Web) are started using Docker Compose.

### Step 2: Inject failure (stop database)
```bash
docker stop db
```

### Step 3: Observe system behavior
Check API logs:
```bash
docker logs api
```

Expected output:
```
DB connection failed: connect ECONNREFUSED <ip>:5432
```

---

## 📊 Observations
- API service continues running even after DB failure  
- Database dependency causes API failure in data operations  
- System shows single point of failure (database)  

---

## 💥 Key Learnings
- Microservices depend heavily on networked services  
- Failure in one service impacts dependent services  
- Docker simplifies simulation of production failures  
- Logs are essential for debugging distributed systems  
- Chaos engineering helps identify system weaknesses  

---

## ⚠️ Identified Issues
- Database is a single point of failure  
- No retry mechanism in API  
- No health checks configured  
- No auto-recovery policies  

---

## 🛠️ Future Improvements
- Add database replication (master-slave setup)  
- Implement retry logic in API service  
- Add Docker health checks  
- Enable restart policies  
- Add monitoring (Prometheus/Grafana)  

---

## 📸 Screenshots to Include
- `docker ps` (all containers running)  
- `docker stop db` (chaos injection)  
- `docker logs api` (failure output)  

---

## 🧠 Conclusion
This project demonstrates a basic distributed system using Docker and successfully simulates failure conditions using chaos engineering. It highlights how dependent services behave under failure and emphasizes the need for resilient system design.

---

## 👨‍💻 Author
MetricMantis Project – Chaos Engineering Demo using Docker