FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 texlive-xetex texlive-lang-chinese texlive-latex-extra && rm -rf /var/lib/apt/lists/*
RUN printf 'openin_any = p\nopenout_any = p\nshell_escape = f\n' > /etc/texmf/texmf.d/99-nxopa-security.cnf && update-texmf
COPY runner.py /opt/runner.py
ENV PYTHONUNBUFFERED=1
CMD ["python3", "/opt/runner.py"]
