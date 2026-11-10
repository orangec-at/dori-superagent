# 도리도라 Discord 창구를 hermes로 옮기기

대화는 hermes(채팅 창구마다 세션이 따로), 일은 dori lead(봉투가 붙은 일만)가 맡는다.

- `SOUL.md`: fedora hermes `doridora` 프로필의 성격 초안. 잡담은 직접, 일은 `to-dori`로 넘긴다.
- `to-dori`: `[reply=<주소> from=<이름>] <할 일>` 봉투를 붙여 `dori send lead`로 넘긴다.
- lead는 결과를 `dori reply <주소> <text>`로 보낸다. `discord:<채널>`은 `~/.dori/bin/dori-reply`(REST 전송)를 쓰므로, 게이트웨이가 hermes로 옮겨가도 그대로 동작한다.

## 전환 절차 (운영자 승인 후에만)

```bash
# 1. 프로필을 만들고 초안과 스크립트를 넣는다 (토큰은 아직 옮기지 않는다)
hermes profile create doridora --description "도리도라: Discord 창구, 일은 dori lead로"
cp examples/hermes-doridora/SOUL.md ~/.hermes/profiles/doridora/SOUL.md
install -D -m 755 examples/hermes-doridora/to-dori ~/.hermes/profiles/doridora/bin/to-dori

# 2. 봉투가 lead에 닿고 답장이 돌아오는지 Discord 없이 확인한다
~/.hermes/profiles/doridora/bin/to-dori hermes:fedora/doridora jaeil "봉투 시험: 이 메시지에 dori reply로 답해줘"

# 3. 기존 브리지를 멈춘다 (같은 봇 토큰으로 게이트웨이 두 개가 붙으면 충돌한다)
systemctl --user disable --now dori-discord.service

# 4. 봇 토큰과 허용 채널을 doridora 프로필로 옮기고 게이트웨이를 켠다
hermes -p doridora gateway setup        # Discord 선택, ~/.dori/discord/bot.env의 DISCORD_BOT_TOKEN 입력
hermes -p doridora gateway install
hermes -p doridora gateway start
hermes -p doridora gateway status

# 5. Discord에서 잡담 한 번, 일 한 번을 보내 확인한다

# 되돌리기
hermes -p doridora gateway stop
systemctl --user enable --now dori-discord.service
```
