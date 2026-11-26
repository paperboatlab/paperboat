# paperboat-cli, before it is erased (not on an upgrade: $1 is then 1): every user's installed apps go with it.
# Their servers stop, the apps and their desktop entries are removed (`paperboat app uninstall --all`), and the
# user's paperboatd stops. Projects, hubs and settings stay in each home.
# ponytail: finds apps under the default ~/.local/share/paperboat; a user's own PAPERBOAT_HOME isn't seen here.
[ "$1" = 0 ] || exit 0
getent passwd | while IFS=: read -r user _ uid _ _ home _; do
  [ -d "$home/.local/share/paperboat/apps" ] || continue
  [ "$uid" -ge 1000 ] 2>/dev/null || [ "$uid" = 0 ] || continue
  runuser -u "$user" -- env HOME="$home" /usr/bin/paperboat app uninstall --all >/dev/null 2>&1 || :
  runuser -u "$user" -- env HOME="$home" /usr/bin/paperboat daemon stop >/dev/null 2>&1 || :
done
exit 0
