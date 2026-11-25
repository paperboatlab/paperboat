#!/usr/bin/perl
# The OpenModelica runtime: paperboat-runtime/0 session mode in front of omc's own interactive server.
#
#   perl serve.pl <socket>        (the mode is always session; exec runs omc directly)
#
# omc listens on ZeroMQ over TCP only, which a --network=none container cannot offer the host. So this
# starts `omc --interactive=zmq` on the container's loopback and speaks to it as a ZeroMQ REQ peer (ZMTP 3,
# the NULL mechanism: a few lines, so the image needs no ZeroMQ binding), and serves the lease's Unix
# socket the way every runtime does. `eval` takes one omc expression and answers omc's reply as
# text/plain. omc answers one call at a time; requests from every connection run in arrival order.
# Perl, because the upstream omc image has it and no Python; core modules only.
use strict;
use warnings;
use IO::Socket::INET;
use IO::Socket::UNIX;
use IO::Select;
use JSON::PP;
use POSIX ();

my $path = shift @ARGV or die "usage: serve.pl <socket>\n";
my $json = JSON::PP->new->utf8->canonical;
$| = 1;

# ── omc ──
my $port = do { my $s = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => 0, Listen => 1) or die "no free port: $!\n"; my $p = $s->sockport; close $s; $p };
my $omc_pid = fork() // die "fork: $!\n";
if (!$omc_pid) {
  open STDIN, '<', '/dev/null';
  open STDOUT, '>&', \*STDERR;
  exec($ENV{PAPERBOAT_OMC} // 'omc', '--interactive=zmq', "--interactivePort=$port", '-z=paperboat') or POSIX::_exit(127);
}
$SIG{TERM} = $SIG{INT} = sub { kill 'KILL', $omc_pid; POSIX::_exit(130) };   # an interrupt ends the session: omc can't stop a call
END { kill 'KILL', $omc_pid if $omc_pid }

my $z;   # the ZMTP connection to omc
for (1 .. 600) {   # up to 60 s: omc reads its settings before it binds
  $z = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => $port) and last;
  die "omc exited at start\n" if waitpid($omc_pid, POSIX::WNOHANG()) == $omc_pid;
  select(undef, undef, undef, 0.1);
}
die "omc did not listen on $port\n" unless $z;
binmode $z;

sub zread { my $n = shift; my $buf = ''; while (length $buf < $n) { my $r = sysread($z, $buf, $n - length $buf, length $buf); die "omc went away\n" unless $r } $buf }
sub zframe {   # (flags, body)
  my ($f) = unpack 'C', zread(1);
  my $n = $f & 2 ? unpack('Q>', zread(8)) : unpack('C', zread(1));
  return ($f, $n ? zread($n) : '');
}
sub zsend { my ($flags, $body) = @_; my $n = length $body; syswrite $z, $n > 255 ? pack('CQ>', $flags | 2, $n) . $body : pack('CC', $flags, $n) . $body }

# greeting: signature, version 3.0, NULL, client; then READY with our socket type
syswrite $z, "\xFF" . ("\0" x 8) . "\x7F" . "\x03\x00" . pack('a20', 'NULL') . "\0" . ("\0" x 31);
zread(64);
zsend(4, "\x05READY" . "\x0BSocket-Type" . pack('N', 3) . 'REQ');
my ($f) = zframe();
die "omc did not say READY\n" unless $f & 4;

sub omc {   # one expression, omc's reply with its trailing newline cut
  my $expr = shift;
  zsend(1, '');   # REQ's empty delimiter
  zsend(0, $expr);
  my $out = '';
  for (;;) {
    my ($fl, $body) = zframe();
    next if $fl & 4;
    $out .= $body;
    last unless $fl & 1;
  }
  $out =~ s/[\r\n]+\z//;
  return $out;
}

my $version = omc('getVersion()');
$version =~ s/^"|"$//g;

# ── paperboat-runtime/0 ──
unlink $path;
my $listen = IO::Socket::UNIX->new(Local => $path, Listen => 16) or die "cannot listen on $path: $!\n";
my $sel = IO::Select->new($listen);
my %buf;

sub send_frame { my ($c, $msg) = @_; my $b = $json->encode($msg); syswrite $c, pack('V', length $b) . $b }
sub hello {
  send_frame(shift, {type => 'hello', protocol => 'paperboat-runtime/0', mode => 'session', pid => $$ + 0,
                     runtime => {name => 'omc', version => $version}, transports => ['uds'], ops => [qw(ping eval interrupt shutdown)]});
}

sub handle {
  my ($c, $req) = @_;
  my ($id, $op, $args) = ($req->{id}, $req->{op} // '', $req->{args} // {});
  my $reply = {id => $id, ok => JSON::PP::true};
  if ($op eq 'ping') { $reply->{result} = {} }
  elsif ($op eq 'eval') { $reply->{result} = {data => {'text/plain' => omc($args->{code} // '')}} }
  elsif ($op eq 'interrupt') { $reply->{result} = {interrupted => JSON::PP::false} }   # the daemon's interrupt ends the session
  elsif ($op eq 'shutdown') { send_frame($c, {%$reply, result => {}}); exit 0 }
  else { $reply = {id => $id, ok => JSON::PP::false, error => {type => 'UnknownOp', message => "no op $op"}} }
  send_frame($c, $reply);
}

for (;;) {
  for my $c ($sel->can_read) {
    if ($c == $listen) { my $n = $listen->accept or next; $sel->add($n); $buf{$n} = ''; hello($n); next }
    my $r = sysread($c, $buf{$c}, 65536, length $buf{$c});
    if (!$r) { $sel->remove($c); delete $buf{$c}; close $c; next }
    while (length $buf{$c} >= 4) {
      my $n = unpack 'V', $buf{$c};
      last if length $buf{$c} < 4 + $n;
      my $body = substr $buf{$c}, 4, $n;
      substr($buf{$c}, 0, 4 + $n) = '';
      my $req = eval { $json->decode($body) } or next;
      eval { handle($c, $req); 1 } or do {
        my $err = $@ =~ s/\s+\z//r;
        send_frame($c, {id => $req->{id}, ok => JSON::PP::false, error => {type => 'OmcError', message => $err}});
        exit 1 if $err eq 'omc went away';   # the lease ends; the client starts a new session
      };
    }
  }
}
