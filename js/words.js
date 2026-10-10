// Common English words. Lessons use the ones made only of unlocked letters;
// when too few qualify, pseudo-words are generated from their letter statistics.
const RAW = `
the be to of and in that have it for not on with he as you do at this but his by from they we say her she or an
will my one all would there their what so up out if about who get which go me when make can like time no just him
know take people into year your good some could them see other than then now look only come its over think also back
after use two how our work first well way even new want because any these give day most us is was are been has had
were said did made find long down may part number sound place where help through much before line right too mean old
same tell boy follow came show around form three small set put end does another large must big such turn here why
ask went men read need land different home move try kind hand picture again change off play spell air away animal
house point page letter mother answer found study still learn should world high every near add food between own
below country plant last school father keep tree never start city earth eye light thought head under story saw left
few while along might close something seem next hard open example begin life always those both paper together got
group often run important until children side feet car mile night walk white sea began grow took river four carry
state once book hear stop without second later miss idea enough eat face watch far real almost let above girl
sometimes mountain cut young talk soon list song being leave family body music color stand sun question fish area
mark dog horse birds problem complete room knew since ever piece told usually friends easy heard order red door sure
become top ship across today during short better best however low hours black products happened whole measure
remember early waves reached listen wind rock space covered fast several hold himself toward five step morning
passed vowel true hundred against pattern table north slowly money map farm pulled draw voice seen cold cried plan
notice south sing war ground fall king town unit figure certain field travel wood fire upon done road half ten fly
gave box finally wait correct person became shown minutes strong verb stars front feel fact inches street decided
contain course surface produce building ocean class note nothing rest carefully scientists inside wheels stay green
known island week less machine base ago stood plane system behind ran round boat game force brought understand warm
common bring explain dry though language shape deep thousands yes clear equation yet government filled heat full hot
check object rule among noun power cannot able six size dark ball material special heavy fine pair circle include
built
line lane rain train lean learn earn near nine tire tile tale tail tear rate late later alter alert inert rent lent
tent tint lint till tell trail trial liner linear entire intern retail retain retina rental eternal latent talent
net tin tan ant art rat tar are ear era eel tee tea ate lit lie nail rail trait treat terrain internal
renal lineal elite inlet trainer retrain tanner tenant linen lenin linter natal nearer rattle little title tilt
tile alien align ankle lair liar near neat neater nettle rattle tear teen tier tinier entail lateral literal
literate literal ratline tartan tarn rant ranter lantern antler learner earner nailer retainer ritual
stone store storm story still stair start state stole sort sore soon soil sole solo stern tones notes noise nose
snail snare sneer stain steal steel stiller sister sitter assert insert nostril lotion notion station nation ration
ratio rotation relation solution resolution tension attention intention oriental original tradition tradition
sudden under under until unit unite united rude ruler sure sound around dust duty study student student industry
sunday yellow year young yard ready daily early lady nearly really easily truly only city style dryly
cloud could color coast count candy cat coat code coin cold cool cord corn cost cotton cradle crane cried crowd
cycle dance decide degree design detail doctor dollar during eagle edge eight either engine enjoy equal error
evening event exact extra figure final finger fruit gold golden grace grain grand grass great green grey guide
hair happy harbor heart hello help hidden history honey honor hope hotel huge human humor hunger hurry
image include indeed injury inner input instead iron itself
jump just job join joy judge juice jacket jazz jelly jewel journey jungle junior jury jaw jar jet jog joke
jolly jeans major object project subject reject adjust enjoy injure ninja banjo pajamas
quick quiet quite quote queen quest quality quarter quiz squeeze square equal require equip liquid unique
quack quake quarry query queue quill quilt squad squid squint aqua acquire conquer request sequence frequent
box fox mix six fix tax wax next text exit exact extra expert explore express extend exist exam excel excite
expand expect exhaust maximum oxygen relax index complex lexicon flex taxi toxic sixty mixer boxer fixture
zebra zero zone zoom zip lazy crazy dozen frozen prize maze amaze breeze freeze puzzle buzz pizza organize
realize citizen horizon wizard blizzard dizzy fuzzy hazard ozone quartz zinc zest razor bronze glaze gaze haze
blaze graze snooze sneeze size seize zigzag zipper dazzle sizzle
very visit voice value view village vote vast vivid valve vapor velvet vehicle venture verse version victory video
vital vocal volume voyage seven over even never river level travel cover silver solve give live love move have
above five drive brave grave wave cave save vine vane vest vowel vivid service survive native active
knife kid kind king kite knee knock knot kick keep kept key kettle kitchen kitten knowledge keen kernel kayak skill
skin sky ask desk dark park mark work walk talk milk silk sink think thank bank blank drink link pink wink sneak
wonder window winter wise wish wolf woman world worth wrap write wrong wagon waist water weather wheel whale whisper
bridge brief bright broken brother brown build bundle burden button bottle bottom border borrow bubble
fable fabric fellow fever fiber fifty fight filter finish flame flavor flight float flower forest forget fortune
garden gather gentle giant ginger glass global glory grape gravity guitar gather
mobile model modern moment monkey monster motion motor muscle museum myself
paint panel parent partner people pepper perfect permit phone piano pilot planet pocket poem poet police
powder praise prepare press pretty price print private profit proper public pulse pupil purple
`;

export const WORDS = [...new Set(RAW.split(/\s+/).filter(w => /^[a-z]{2,}$/.test(w)))];
