#!/bin/sh
# certbot deploy-hook: 证书续期成功后，通过 Docker socket 通知 nginx reload
# certbot 官方镜像基于 Python，利用 Python 访问 unix socket
python3 -c "
import http.client, socket, json

class DockerSocket(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost')
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')

conn = DockerSocket()
conn.request('GET', '/containers/json?filters={\"label\":[\"com.docker.compose.service=nginx\"]}')
resp = conn.getresponse()
containers = json.loads(resp.read())
if containers:
    cid = containers[0]['Id']
    conn.request('POST', f'/containers/{cid}/kill?signal=HUP')
    conn.getresponse()
    print('[certbot-renew] nginx reloaded (SIGHUP)')
else:
    print('[certbot-renew] WARNING: nginx container not found')
" 2>&1 || echo "[certbot-renew] WARNING: failed to reload nginx, manual reload required"
