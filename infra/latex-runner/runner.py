"""Offline TeX runner. Each compilation drops to a distinct UID and private directory."""
import json, os, pathlib, resource, signal, subprocess, time, shutil, base64, re

ROOT=pathlib.Path(os.environ.get('LATEX_SPOOL','/jobs'))
ROOT.mkdir(parents=True,exist_ok=True)
sequence=0

def run(job):
    global sequence
    owner=job.stat().st_uid
    sequence+=1
    uid=100000+sequence
    request=json.loads((job/'request.json').read_text())
    if request.get('expiresAt',0)<time.time()*1000: raise ValueError('Expired compilation lease')
    source=request['source']
    if not isinstance(source,str) or len(source)>250000:
        raise ValueError('Invalid or oversized template')
    work=job/'input'
    # A restart can leave auxiliary files owned by a previous compile UID.
    shutil.rmtree(work,ignore_errors=True)
    work.mkdir(mode=0o700)
    (work/'document.tex').write_text(source)
    assets=request.get('assets',{})
    if not isinstance(assets,dict) or len(assets)>30: raise ValueError('Invalid assets')
    total=0
    (work/'assets').mkdir(mode=0o700,exist_ok=True)
    for name, encoded in assets.items():
        if not re.fullmatch(r'photo-[a-f0-9-]{36}\.(png|jpg)',name): raise ValueError('Invalid asset path')
        data=base64.b64decode(encoded,validate=True)
        total+=len(data)
        if total>25*1024**2: raise ValueError('Assets exceed limit')
        (work/'assets'/name).write_bytes(data)
    for file in [work,work/'document.tex',work/'assets',*list((work/'assets').iterdir())]:
        os.chown(file,uid,uid)
        os.chmod(file,0o700 if file.is_dir() else 0o600)
    # Parent paths contain no candidate data; the compile child can enter only its own input directory.
    os.chmod(job,0o711)
    def sandbox():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CPU,(30,30))
        resource.setrlimit(resource.RLIMIT_AS,(1024**3,1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE,(10*1024**2,10*1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
    environment={'PATH':'/usr/bin:/bin','HOME':str(work),'LANG':'C.UTF-8','openin_any':'p','openout_any':'p','TEXMFOUTPUT':str(work),'TEXMFVAR':str(work/'texmf-var')}
    logs=[]
    for _ in range(2):
        proc=subprocess.Popen(['xelatex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','document.tex'],cwd=work,env=environment,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,preexec_fn=sandbox,start_new_session=True)
        try:
            output,_=proc.communicate(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid,signal.SIGKILL)
            proc.wait()
            raise ValueError('Compilation exceeded time limit')
        logs.append(output.decode('utf-8',errors='replace'))
        if proc.returncode:
            # Keep the useful tail; logs stay behind authorization and never contain environment credentials.
            raise ValueError('\n'.join(logs)[-2500:])
    shutil.copyfile(work/'document.pdf',job/'document.pdf')
    os.chown(job/'document.pdf',owner,owner)
    os.chmod(job/'document.pdf',0o600)
    return owner

# A restarted container resumes unfinished jobs; no old child survives a restart.
for marker in ROOT.glob('*/running'): marker.unlink(missing_ok=True)
print('Offline XeLaTeX runner ready',flush=True)
while True:
    for request in ROOT.glob('*/request.json'):
        job=request.parent
        if (job/'result.json').exists() or (job/'running').exists(): continue
        try:
            owner=job.stat().st_uid
            (job/'running').touch()
            run(job)
            result={'ok':True}
        except Exception as error:
            result={'ok':False,'error':str(error)[-2500:]}
        finally:
            (job/'request.json').unlink(missing_ok=True)
            shutil.rmtree(job/'input',ignore_errors=True)
            try:
                for p in job.iterdir():
                    os.chown(p,owner,owner)
                os.chown(job,owner,owner)
                os.chmod(job,0o700)
            except FileNotFoundError:
                pass
        try:
            temp=job/'result.tmp'
            temp.write_text(json.dumps(result))
            os.chown(temp,owner,owner)
            os.chmod(temp,0o600)
            temp.rename(job/'result.json')
        except FileNotFoundError:
            pass  # A cancelled or expired execution may have removed its spool.
    time.sleep(0.5)
