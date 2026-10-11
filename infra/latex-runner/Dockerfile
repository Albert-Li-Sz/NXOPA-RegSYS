FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 texlive-xetex texlive-lang-chinese texlive-latex-extra && rm -rf /var/lib/apt/lists/*
COPY runner.py /opt/runner.py
ENV PYTHONUNBUFFERED=1
CMD ["python3", "/opt/runner.py"]
