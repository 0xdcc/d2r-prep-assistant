"""Create local test bundles; preserve Mach-O permissions and symlinks."""
from pathlib import Path
import hashlib,json,os,stat,zipfile
root=Path(__file__).resolve().parents[1]
artifacts=root/'artifacts'
rows=[]
for platform in ('win32-x64','darwin-arm64'):
    folder=artifacts/f'D2R Prep Assistant-{platform}'
    output=artifacts/f'D2R-Prep-Assistant-0.1.0-{platform}-unsigned.zip'
    count=0
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as z:
        for base,dirs,files in os.walk(folder,followlinks=False):
            for name in sorted(dirs+files):
                p=Path(base)/name
                arc=str(p.relative_to(artifacts)).replace(os.sep,'/')
                s=p.lstat()
                if stat.S_ISLNK(s.st_mode):
                    i=zipfile.ZipInfo(arc)
                    i.create_system=3
                    i.external_attr=(stat.S_IFLNK|0o777)<<16
                    z.writestr(i,os.readlink(p))
                else:
                    z.write(p,arc)
                count+=1
    with zipfile.ZipFile(output) as z:
        assert z.testzip() is None
        assert not any('/evidence/' in n or '/.cache/' in n or '/tests/' in n or '/node_modules/' in n for n in z.namelist())
    h=hashlib.sha256()
    with output.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    rows.append({'platform':platform,'path':str(output),'bytes':output.stat().st_size,'sha256':h.hexdigest(),'entries':count,'unsigned':True,'macNativeRun':False if platform=='darwin-arm64' else None})
(artifacts/'bundle-manifest.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
(artifacts/'SHA256SUMS.txt').write_text(''.join(f'{r["sha256"]}  {Path(r["path"]).name}\n' for r in rows))
print(json.dumps(rows,ensure_ascii=False,indent=2))
