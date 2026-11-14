"""上传暂存由任务持有，输入框回执不代表文件已被网页读取。"""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import re
import stat
from .browsers import NAMES as BROWSER_NAMES
from .errors import BrowserUseError
from .resources import ResourceLedger, _pairs

class UploadLedger(ResourceLedger):
    def _read(self, directory):
        try:fd=self._open_file(directory,self._name,create=False)
        except FileNotFoundError:return [],None
        try:
            info=os.fstat(fd)
            raw=os.read(fd,4*1024*1024+1)
            if len(raw)>4*1024*1024:raise ValueError('upload ledger too large')
            values=json.loads(raw,object_pairs_hook=_pairs)
            if not isinstance(values,list):raise ValueError('list required')
            for item in values:
                if not isinstance(item,dict) or set(item)!={'owner','browser','targetId','stage','files'}:raise ValueError('invalid upload record')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',item['owner']) or item['browser'] not in BROWSER_NAMES or not isinstance(item['targetId'],str):raise ValueError('invalid owner')
                self._descriptor(item['stage'])
                if not isinstance(item['files'],dict) or set(item['files'])-set(item['stage']['files']) or any(not isinstance(v,list) or len(v)!=4 or any(type(n) is not int or n<0 for n in v) for v in item['files'].values()):raise ValueError('invalid files')
            return values,self._identity(info)
        except (ValueError,TypeError,KeyError) as exc:raise BrowserUseError('上传归属账损坏，拒绝重置',5) from exc
        finally:os.close(fd)

    @staticmethod
    def _descriptor(stage):
        if not isinstance(stage,dict) or set(stage)!={'directory','device','inode','files'}:raise BrowserUseError('上传暂存描述不合法',2)
        if not isinstance(stage['directory'],str) or not re.fullmatch(r'/tmp/browser-use-stage-[A-Za-z0-9]{12}',stage['directory']):raise BrowserUseError('上传暂存必须是本次独立目录',6)
        if any(type(stage[k]) is not int or stage[k]<0 for k in ('device','inode')):raise BrowserUseError('上传暂存缺少实际身份',2)
        names=stage['files']
        if not isinstance(names,list) or len(names)>200 or any(not isinstance(n,str) for n in names) or len(set(names))!=len(names) or any(not isinstance(n,str) or '/' in n or '\x00' in n or not re.fullmatch(r'(?:[0-9a-f]{32}-.+|\.transfer-[0-9a-f]{32})',n) for n in names):raise BrowserUseError('上传暂存文件名不合法',2)
        return stage

    @staticmethod
    def _open_stage(stage):
        # /tmp在macOS是系统软链；只允许这一固定入口，拒绝stage自身软链。
        directory=Path('/tmp').resolve()/Path(stage['directory']).name
        try:fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        except OSError as exc:raise BrowserUseError('上传暂存目录不可安全读取',5) from exc
        info=os.fstat(fd)
        if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700 or (info.st_dev,info.st_ino)!=(stage['device'],stage['inode']):
            os.close(fd);raise BrowserUseError('上传暂存目录身份已变化，拒绝接管或删除',6)
        return directory,fd

    def register(self,owner,browser,target,stages,selected_files):
        if not isinstance(owner,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',owner) or browser not in BROWSER_NAMES or not isinstance(target,str) or not target:raise BrowserUseError('上传归属需要明确任务、浏览器和目标',2)
        if not isinstance(stages,list) or not stages or len(stages)>20:raise BrowserUseError('上传暂存记录需要非空列表',2)
        selected=set(selected_files or [])
        checked=[]
        for stage in stages:
            stage=copy.deepcopy(self._descriptor(stage));path,fd=self._open_stage(stage)
            try:
                entries=os.listdir(fd)
                if set(entries)-set(stage['files']):raise BrowserUseError('上传暂存包含未认领文件',6)
                identities={}
                for name in entries:
                    info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600:raise BrowserUseError('上传暂存文件不安全',6)
                    identities[name]=[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns]
                owned={stage['directory']+'/'+name for name in entries}
                if not selected.intersection(owned):raise BrowserUseError('上传文件不在本次暂存记录中',6)
                checked.append({'owner':owner,'browser':browser,'targetId':target,'stage':stage,'files':identities})
            finally:os.close(fd)
        all_owned={i['stage']['directory']+'/'+n for i in checked for n in i['files']}
        if selected-all_owned:raise BrowserUseError('上传文件与暂存记录不一致',6)
        with self._transaction() as (directory,records,previous):
            for item in checked:
                same=next((r for r in records if r['stage']['directory']==item['stage']['directory']),None)
                if same is not None and same!=item:raise BrowserUseError('上传暂存已属于其他目标或身份变化',6)
                if same is None:records.append(item)
            self._write(directory,records,previous)
        return {'registered':len(checked),'stageUntilRelease':True}

    @staticmethod
    def _delete(item):
        stage=item['stage'];path=Path('/tmp').resolve()/Path(stage['directory']).name
        if not os.path.lexists(path):return
        path,fd=UploadLedger._open_stage(stage)
        try:
            entries=os.listdir(fd)
            if set(entries)-set(item['files']):raise BrowserUseError('上传暂存含未登记文件，拒绝删除',6)
            for name in entries:
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                identity=[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns]
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or identity!=item['files'][name]:raise BrowserUseError('上传暂存文件被替换或修改，拒绝删除',6)
            for name in entries:os.unlink(name,dir_fd=fd)
            info=os.stat(path,follow_symlinks=False)
            if (info.st_dev,info.st_ino)!=(stage['device'],stage['inode']):raise BrowserUseError('上传目录被替换，拒绝删除',6)
            os.rmdir(path)
        except OSError as exc:raise BrowserUseError('上传暂存清理失败，保留归属供核对',5) from exc
        finally:os.close(fd)

    def release(self,owner=None,browser=None,target=None):
        cleaned,errors=[],[]
        with self._transaction() as (directory,records,previous):
            keep=[]
            for item in records:
                if (owner is not None and item['owner']!=owner or browser is not None and item['browser']!=browser or target is not None and item['targetId']!=target):keep.append(item);continue
                try:self._delete(item);cleaned.append(item['stage']['directory'])
                except BrowserUseError as exc:keep.append(item);errors.append(exc.as_dict())
            self._write(directory,keep,previous)
        if errors:raise BrowserUseError('部分上传暂存未能清理',5,data={'cleaned':cleaned,'errors':errors})
        return {'cleaned':cleaned}
