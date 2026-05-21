FROM python:3.13-slim

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir flask>=3.1.3

COPY . .

EXPOSE 8899

CMD ["python3", "server.py"]
