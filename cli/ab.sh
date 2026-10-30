#!/bin/bash
# A/B test the search AI: VARIANT options vs BASE options (both merged over the quick level).
# usage (from the repo root): cli/ab.sh NAME 'VARIANTJSON' [games per shard=60] [shards=6]   -> appends a line to ab-results.txt
N=$1; V=$2; B0=${BASE:-'{}'}; G=${3:-60}; K=${4:-6}; OUT=${OUT:-ab-out}
mkdir -p $OUT
for ((k=0;k<K;k++)); do VARIANT="$V" BASE="$B0" SALT="${SALT:-0}" npx tsx cli/ab.ts $G $k > $OUT/$N-$k.txt 2>&1 & done; wait
cat $OUT/$N-*.txt | node -e "let w=0,n=0;require('fs').readFileSync(0,'utf8').trim().split('\n').forEach(l=>{try{const o=JSON.parse(l);w+=o.w;n+=o.n}catch(e){console.log('ERR',l.slice(0,200))}});console.log(new Date().toISOString().slice(0,16),'$N','variant wins',w+'/'+n,(100*w/n).toFixed(1)+'%','(±'+(100/Math.sqrt(n)).toFixed(1)+')')" | tee -a ab-results.txt
