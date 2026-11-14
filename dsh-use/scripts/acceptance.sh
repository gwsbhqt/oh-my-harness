#!/bin/bash
# dsh-use 功能冒烟验收：doctor 管「起不起得来」，这个剧本管「功能是不是活的」。
# 前面全是只读命令；最后在 /tmp/dsh-use-acceptance 开一个 fast 档一次性会话，
# 发一句话、等它跑完、把回复打出来。会话记录留在列表里，不用时在界面归档即可。
# 用法：scripts/acceptance.sh；任何一步失败即非零退出（set -e）。
set -euo pipefail

echo '== health =='        && dsh-use health
echo '== workspaces =='    && dsh-use workspaces
echo '== sessions =='      && dsh-use sessions
echo '== quota =='         && dsh-use quota
echo '== pick fast =='     && dsh-use pick --tier fast

echo '== new + chat（一次性会话，fast 档） =='
mkdir -p /tmp/dsh-use-acceptance
sid=$(dsh-use new /tmp/dsh-use-acceptance --tier fast | grep -oE 'session-[0-9a-f-]+' | head -1)
[ -n "$sid" ] || { echo '没拿到新会话 id' >&2; exit 1; }
echo "会话：$sid"
dsh-use chat "$sid" '只回复 ok 两个字母，别的什么都不要说。' --timeout 300
echo '== last =='          && dsh-use last "$sid"

echo 'acceptance OK'
