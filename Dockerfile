FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py .
COPY Tennis-Analytics/ ./Tennis-Analytics/

CMD ["python", "-u", "bot.py"]
