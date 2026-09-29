/**
 * 本地假 SMTP：用来验证告警邮件通道，不需要真实邮箱。
 *
 *   node tools/fake-smtp.mjs                 # 监听 127.0.0.1:2525
 *   node tools/fake-smtp.mjs --port 2526
 *
 * 然后在管理台「告警」页填：
 *   SMTP 服务器 127.0.0.1 / 端口 2525 / 关掉「隐式 TLS」/ 打开「允许明文认证」
 *   账号 me@local / 密码随便填 / 收件人 me@local
 * 点「发送测试」——终端会打印出收到的邮件（主题与正文都能看到）。
 */
import net from 'net';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PORT = Number(arg('--port', 2525));
const HOST = arg('--host', '127.0.0.1');

let count = 0;
const server = net.createServer((sock) => {
  let buf = '';
  let inData = false;
  let lines = [];
  let stage = 0;
  let user = null;
  let pwd = null;
  const send = (l) => sock.write(l + '\r\n');
  send('220 fake-smtp ready');

  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          count++;
          const raw = lines.join('\r\n');
          const [head, ...rest] = raw.split('\r\n\r\n');
          const subject = (head.match(/^Subject: (.*)$/m) || [])[1] || '';
          const body = rest.join('\r\n\r\n').replace(/\r\n/g, '');
          const b64 = subject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
          console.log(`\n════════ 收到第 ${count} 封邮件 ════════`);
          console.log(`时间: ${new Date().toISOString()}`);
          console.log(`认证: ${user || '(无)'} / ${pwd ? '****' : '(无)'}`);
          console.log(`主题: ${Buffer.from(b64, 'base64').toString('utf8')}`);
          console.log('正文:');
          console.log(Buffer.from(body, 'base64').toString('utf8'));
          console.log('════════════════════════════════════');
          lines = [];
          send('250 2.0.0 Ok: queued');
        } else {
          lines.push(line);
        }
        continue;
      }
      const cmd = line.split(' ')[0].toUpperCase();
      if (stage === 1) { user = Buffer.from(line, 'base64').toString('utf8'); stage = 2; send('334 UGFzc3dvcmQ6'); continue; }
      if (stage === 2) { pwd = Buffer.from(line, 'base64').toString('utf8'); stage = 0; send('235 2.7.0 Authentication successful'); continue; }
      if (cmd === 'EHLO' || cmd === 'HELO') {
        send('250-fake-smtp greets you');
        send('250-AUTH LOGIN PLAIN');
        send('250 SIZE 10485760');
      } else if (cmd === 'AUTH') {
        if (/^AUTH LOGIN/i.test(line)) { stage = 1; send('334 VXNlcm5hbWU6'); }
        else send('235 2.7.0 Authentication successful');
      } else if (cmd === 'MAIL' || cmd === 'RCPT') {
        send('250 2.1.0 Ok');
      } else if (cmd === 'DATA') {
        inData = true;
        send('354 End data with <CR><LF>.<CR><LF>');
      } else if (cmd === 'QUIT') {
        send('221 2.0.0 Bye');
        sock.end();
      } else {
        send('250 OK');
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`fake SMTP 已启动：${HOST}:${PORT}（无 TLS，支持 AUTH LOGIN）`);
  console.log('在管理台「告警」页把 SMTP 指到这里即可验证邮件通道。Ctrl+C 退出。');
});
