// ============================================================
// 收樣紀錄分頁：從收樣紀錄總表 (incomingsample.pages.dev) 撈取資料，
// 智慧比對「廠商名稱」與報價系統「客戶名稱」，並依「取樣測項」比對該客戶
// 報價單裡對應那一項檢驗的單價（不是整張報價單的總價，才能拿來拉當月業
// 績）。比對不到的可以手動輸入金額，會雲端同步保存。
// ============================================================
const INCOMING_BASE = 'https://incomingsample.pages.dev/';
const INCOMING_PAGE_SIZE = 100;

let incomingManifest = null;      // manifest.json 內容
let incomingRows = [];            // 已載入的收樣資料（含比對結果）
let incomingLoadedYms = [];       // 目前載入的月份
let incomingPage = 1;
let incomingLoading = false;
const incomingMonthCache = {};    // ym -> rows

// 同一個「報告號碼」底下常常不只一列（同一份樣品可能同時做好幾個測項），
// 所以不管是判斷重複資料、還是手動輸入金額要記在哪一列，都不能只用報告
// 號碼當 key，一定要「報告號碼＋取樣測項＋樣品名稱」三個一起才是唯一的
// 一列。這裡統一提供一個function，避免各處寫法不一致。
function incomingRowKey_(r) {
  return (r.report_no || '') + '' + (r.test_item || '') + '' + (r.sample || '');
}

// 手動輸入的金額覆蓋層：rowKey（incomingRowKey_ 算出來的報告號碼＋測項＋
// 樣品名稱組合）-> { amount, reportNo, testItem, sample, vendor, customer,
// updatedAt }。雲端同步（跟客戶/檢驗項目/報價記錄/常用備註一樣，整批覆蓋
// 對應試算表分頁）。
let incomingAmountOverrides = {};
// 舊版本只用報告號碼存手動金額（沒有記錄是哪個測項），從雲端讀回來但還沒
// 辦法還原成新格式的，先放這裡暫存，等 loadIncomingData 把收樣資料載好、
// 知道這個報告號碼底下實際有哪些測項列之後，再一次搬遷成新格式。
let incomingLegacyAmountOverrides = {};

// 使用者整理的「取樣測項 → 報價單品名」對照表（因為很多取樣測項跟報價單
// 品名寫法差很多、自動比對抓不到，這份是人工核對過的正確對應，比對優先度
// 最高，比自動比對／關鍵字比對都可信）。key 是收樣紀錄的「取樣測項」，
// value 是這個測項在報價單裡『可能』出現的品名（同一個測項不同報價單有時
// 措辭會不一樣，所以是一個陣列，比對時全部都會試）。
const ITEM_ALIAS_RAW = {"寵物農殘413項(委外)":["寵物食品-農殘413項"],"黴菌及酵母菌":["黴菌","黴菌&酵母菌","黴菌及酵母菌(AOAC)"],"動物性成分(委外)":["動物性成分檢驗－魚類","動物性成分定性篩選(委台美執行)"],"甲醛":["食品中甲醛"],"寵物-丙二醇":["寵物食品-丙二醇"],"乙醇(委外)":["酒精(CNS14849)(委合作實驗室)"],"抗菌試驗":["抗菌試驗-白色念珠菌"],"維生素C":["維生素C","維生素C(委合作實驗室)"],"鹽度(委外)":["鹽度(電位差硝酸銀滴定法)"],"曲狀桿菌(轉送)":["曲狀桿菌(委合作實驗室)"],"霍亂弧菌(轉送)":["霍亂弧菌(委合作實驗室)"],"志賀氏桿菌(轉送)":["志賀氏桿菌(委合作實驗室)"],"肉毒桿菌(委外)":["肉毒桿菌(委合作實驗室)"],"顏色":["顏色","安定性試驗-顏色"],"塗抹-大腸桿菌群":["大腸桿菌群(塗抹)(合測價)","大腸桿菌群(塗抹)"],"塗抹-大腸桿菌":["大腸桿菌(塗抹)(合測價)","大腸桿菌(塗抹)"],"塗抹-總生菌數":["總生菌數(塗抹)(合測價)","總生菌數(塗抹)"],"飲用水水質重金屬":["飲用水水質重金屬-砷鉛鎘汞銅鋅","飲用水水質重金屬-鉛、砷","飲用水水質重金屬-砷","飲用水水質重金屬-鉛","飲用水水質重金屬9項","飲用水水質重金屬9項：砷、鉛、硒、鉻、鎘、鋇、銻、鎳、汞"],"丙二醇(委外)":["丙二醇(委合作實驗室)"],"防腐效能":["化妝品5菌+防腐效能測試(組合價)"],"寵物-三聚氰胺":["寵物食品-三聚氰胺"],"無機砷":["寵物食品-無機砷"],"寵物-黃麴毒素":["寵物食品-黃麴毒素4項"],"寵物-致病性大腸桿菌":["寵物食品-致病性大腸桿菌","致病性大腸桿菌"],"寵物-李斯特菌(定性)":["寵物食品-單核細胞增生性李斯特菌(定性)"],"寵物-產氣莢膜":["寵物食品-產氣莢膜梭菌"],"寵物-沙門氏桿菌":["寵物食品-沙門氏菌"],"食品無機砷":["食品中無機砷(適用基質藻類、米類、水產動物類及魚油)(合測價）","食品中無機砷(適用基質藻類、米類、水產動物類及魚油)"],"甲基汞":["甲基汞(合測價)","甲基汞"],"糖度(委外)":["糖度(Brix)(委合作實驗室)"],"總花青素(委外)":["總花青素(Totalanthocyanidins)(委合作實驗室)","總花青素(Anthocyanidins)(比色法)(委合作實驗室)"],"原花青素(委外)":["原花青素(Proanthocyanidins)(委合作實驗室)"],"農殘411(轉送)":["多重農殘檢測套裝-411(委合作實驗室)"],"礦物質":["礦物元素-鈣、磷","礦物元素-鈣、鎂、鈉、鉀、硒","單一礦物元素","礦物元素-鐵","礦物元素-鎂","礦物元素-磷","礦物元素-錳","礦物元素-鈣","礦物元素-硒","礦物元素-鋅","礦物元素-鈣、鐵","礦物元素-氯"],"維生素K2(委外)":["維生素K2(委合作實驗室)"],"李斯特菌(定量)":["單核細胞增生性李斯特菌(定量)(合測價)","單核細胞增生性李斯特菌(定量)"],"金黃色葡萄球菌(CFU)":["金黃色葡萄球菌(合測價)","金黃色葡萄球菌"],"李斯特菌(定性)":["單核細胞增生性李斯特菌(定性)(合測價)","單核細胞增生性李斯特菌(定性)"],"腸炎弧菌":["腸炎弧菌(合測價)","腸炎弧菌"],"退伍軍人菌(轉送)":["退伍軍人菌(委合作實驗室)"],"餐具試驗-蛋白質殘留":["餐具檢測-蛋白質殘留"],"溶出試驗-4% 醋酸:重金屬以鉛計":["溶出試驗-4%醋酸:重金屬以鉛計","溶出試驗-4%醋酸:重金屬(以鉛計)"],"飲料重金屬-鉛":["飲料重金屬-鉛"],"包裝飲用水-糞便性鏈球菌(CFU)":["包裝飲用水-糞便性鏈球菌(合測價)","包裝飲用水-糞便性鏈球菌"],"包裝飲用水-綠膿桿菌(CFU)":["包裝飲用水-綠膿桿菌(合測價)","包裝飲用水-綠膿桿菌"],"包裝飲用水-大腸桿菌群(CFU)":["包裝飲用水-大腸桿菌群(合測價)","包裝飲用水-大腸桿菌群"],"色度(委外)":["色度(委合作實驗室)"],"濁度(委外)":["濁度(委合作實驗室)"],"落菌-黴菌及酵母菌":["黴菌及酵母菌(環境落菌）"],"何首烏苷":["何首烏苷"],"黃耆甲苷":["黃耆甲苷(AstragalosideIV)"],"稀乙醇抽提物":["中藥-稀乙醇抽提物"],"水抽提物":["中藥-水抽提物"],"乾燥減重":["中藥-乾燥減重","中藥-水分(乾燥減重)"],"酸不溶性灰分":["中藥-酸不溶性灰分"],"總灰分":["中藥-總灰分"],"塗抹-金黃色葡萄球菌(CFU)":["金黃色葡萄球菌(塗抹)"],"蔬果重金屬-鎘":["蔬果植物類重金屬-鎘"],"NIEA-大腸桿菌(CFU)":["水質-大腸桿菌(NIEA)(合測價)","水質-大腸桿菌(NIEA)"],"NIEA-大腸桿菌群(CFU)":["水質-大腸桿菌群(NIEA)(合測價)","水質-大腸桿菌群(NIEA)"],"NIEA-總生菌數":["水質-總菌落數(NIEA)(合測價)","水質-總菌落數(NIEA)","水質-生菌數(NIEA)","水質-生菌數(NIEA)(合測價)"],"腸桿菌科":["腸桿菌科(合測價)","腸桿菌科"],"沙門氏桿菌":["沙門氏菌(合測價)","沙門氏菌","沙門氏菌(AOAC)"],"玉米黃素(轉送)":["玉米黃素(委合作實驗室)","玉米黃素"],"葉黃素(轉送)":["葉黃素(以游離型葉黃素計)","游離型葉黃素","酯化型葉黃素"],"穀類重金屬-鉛、鎘、汞":["穀類重金屬-鉛、鎘、汞"],"溶出試驗-4% 醋酸:銻、鍺(轉送)":["溶出試驗-4%醋酸：銻、鍺(委合作實驗室)"],"包裝(盛裝)飲用水及食用冰塊中重金屬":["包裝(盛裝)飲用水及食用冰塊中重金屬-鎘"],"餐具試驗-烷基苯磺酸鹽":["餐具檢測-烷基苯磺酸鹽"],"餐具試驗-澱粉":["餐具檢測-澱粉殘留"],"餐具試驗-油脂":["餐具檢測-油脂殘留"],"包材外觀":["包材外觀"],"大腸桿菌群":["大腸桿菌群(合測價)","大腸桿菌群"],"大腸桿菌":["大腸桿菌(合測價)","大腸桿菌","大腸桿菌O157:H7","化妝品微生物4項：大腸桿菌、綠膿桿菌、金黃色葡萄球菌、白色念珠菌"],"總生菌數":["總生菌數(合測價)","總生菌數","中藥-好氧性總生菌數"],"防腐劑五項":["全家-防腐劑5項","防腐劑5項","防腐劑5項：苯甲酸、己二烯酸、去水醋酸、對羥基苯甲酸、水楊酸","化妝品防腐劑5項","化妝品防腐劑5項：苯甲酸、己二烯酸、去水醋酸、對羥基苯甲酸、水楊酸"],"灰分":["中藥-灰分","灰分"],"比重":["化妝品-比重"],"農殘410":["多重農殘檢測套裝-410"],"農殘411":["多重農殘檢測套裝-411"],"二硫代胺基甲酸鹽":["二硫代胺基甲酸鹽類"],"極性農藥及其代謝物(轉送)":["極性農藥及其代謝物多重殘留(委合作實驗室)","食品中殘留農藥檢驗方法－極性農藥及其代謝物多重殘留分析(委合作實驗室)"],"農殘方法六(委外)":["農藥多重殘留分析(方法六)(委合作實驗室)"],"穀類重金屬-鉛鎘砷":["穀類中重金屬-鉛、鎘、砷"],"水產重金屬-鉛、鎘":["水產品、禽畜產品：鉛、鎘(合測價)","水產品、禽畜產品：鉛、鎘","水產品中重金屬-鉛、鎘"],"菇類重金屬-鉛、鎘":["菇類重金屬-鉛、鎘"],"蔬果重金屬-鉛、鎘":["蔬果植物類重金屬-鉛、鎘"],"果凍、果醬重金屬-鉛":["果凍、果醬重金屬-鉛"],"藻類中重金屬-鉛、鎘、汞":["藻類中重金屬-鉛、鎘、汞"],"罐頭重金屬-鉛":["罐頭中重金屬-鉛"],"罐頭重金屬-錫":["罐頭中重金屬-錫"],"蛋類重金屬-鉛、銅":["蛋類重金屬-鉛、銅"],"乳品中重金屬-鉛":["乳品中重金屬-鉛"],"飲料重金屬-砷、鉛、銅、銻":["飲料中重金屬-砷、鉛、銅、銻"],"飲料重金屬-砷、鉛、銅":["飲料中重金屬-砷、鉛、銅"],"嬰幼兒重金屬-鉛鎘":["嬰幼兒食品中重金屬-鉛、鎘"],"畜禽類重金屬-鉛、鎘":["水產品、禽畜產品：鉛、鎘(合測價)","水產品、禽畜產品：鉛、鎘","禽畜產品中重金屬-鉛、鎘"],"水產及禽畜重金屬2項：鉛、鎘":["水產品、禽畜產品：鉛、鎘(合測價)","水產品、禽畜產品：鉛、鎘","水產品中重金屬-鉛、鎘","禽畜產品中重金屬-鉛、鎘"],"蜂蜜重金屬-鉛":["蜂蜜中重金屬-鉛"],"重金屬(以鉛計)":["重金屬(以鉛計)","中藥-重金屬(以鉛計)"],"(比色法)砷-1法(以三氧化二砷計)":["砷(比色法)-1法(以三氧化二砷計)"],"礦物質-鉀、鈣、鐵":["礦物元素-鉀、鈣、鐵","鉀、鈣、鐵"],"礦物質-鉀":["礦物元素-鉀"],"礦物質-鈉":["礦物元素-鈉"],"赭麴毒素":["赭麴毒素"],"黃麴毒素":["黃麴毒素4項","黃麴毒素4項：B1、B2、G1、G2"],"黃麴毒素-M1":["黃麴毒素M1(委合作實驗室)"],"棒麴毒素(委外)":["棒麴毒素(委合作實驗室)"],"橘黴素(委外)":["橘黴素(委合作實驗室）"],"Monacolin K":["紅麴菌素K(MonacolinK)(委合作實驗室）"],"多重毒素11項":["多重毒素殘留11項","寵物食品-多重毒素11項"],"外觀判定":["安定性試驗-外觀","安定性試驗-外觀、顏色、氣味","罐頭食品-外觀檢查(CNS969)"],"(MS)重金屬-2項":["重金屬-鉛鎘(總則)"],"甜味劑13項":["多重甜味劑13項","多重甜味劑13項：醋磺內酯鉀、阿斯巴甜、對位乙氧苯脲(甘精)、甘草素、新橘皮苷二氫查爾酮、紐甜、環己基代磺醯胺酸鈉、糖精鈉、甜菊糖、蔗糖素、Alitame、RebaudiosideA、RebaudiosideB"],"防腐劑七項":["防腐劑7項","防腐劑7項：對羥苯甲酸甲酯、乙酯、丙酯、異丙酯、丁酯、第二丁酯、異丁酯","化妝品防腐劑7項","化妝品防腐劑7項：對羥苯甲酸甲酯、乙酯、丙酯、異丙酯、丁酯第二丁酯、異丁酯"],"防腐劑十二項":["防腐劑12項","防腐劑12項：苯甲酸、己二烯酸、去水醋酸、對羥基苯甲酸、水楊酸、對羥苯甲酸甲酯、乙酯、丙酯、異丙酯、丁酯、第二丁酯、異丁酯"],"丙酸":["丙酸"],"二甲基黃及二乙基黃(委外)":["二甲基黃及二乙基黃(委合作實驗室）"],"著色劑8項":["食品中著色劑8項","食品中著色劑8項：食用紅色六號、食用紅色七號、食用黃色四號、食用黃色五號、食用藍色一號、食用藍色二號、食用綠色三號、食用紅色四十號"],"維生素A(委外)":["維生素A"],"維生素E(委外)":["維生素E"],"維生素B6(委外)":["維生素B6(吡哆醇)"],"維生素B9(葉酸)(轉送)":["維生素B9(葉酸)"],"維生素B12(委外)":["維生素B12"],"維生素K(轉送)":["維生素K"],"寵物-五大營養":["寵物食品-五大營養成分"],"八大營養":["八大營養成分"],"熱量":["熱量"],"粗蛋白":["粗蛋白"],"碳水化合物":["碳水化合物"],"粗脂肪":["粗脂肪"],"飽和脂肪":["飽和脂肪"],"反式脂肪":["反式脂肪"],"水分":["水分"],"膳食纖維(2001.03)(委外)":["膳食纖維(AOAC2001.03)"],"粗纖維":["粗纖維"],"膽固醇":["膽固醇(AOAC994.10）"],"維生素D (0.896)":["維生素D(含D2&D3)"],"脂肪酸組成":["食品脂肪酸組成"],"仙人掌桿菌(CFU)":["仙人掌桿菌"],"乳酸菌":["乳酸菌"],"金黃色葡萄球菌腸毒素":["金黃色葡萄球菌腸毒素"],"塗抹-李斯特菌(定性)":["單核細胞增生性李斯特菌(定性)(塗抹)","單核细胞增生性李斯特菌(定性) (塗抹)"],"產氣莢膜":["產氣莢膜梭菌"],"AOAC-生菌數":["生菌數(AOAC)"],"AOAC-大腸桿菌":["大腸桿菌(AOAC)"],"AOAC-金黃色葡萄球菌":["金黃色葡萄球菌(AOAC)"],"AOAC-李斯特菌":["李斯特菌(AOAC)"],"溴酸鹽(委外)":["水質-溴酸鹽(委合作實驗室）"],"水質-導電度":["水質-導電度(NIEA)"],"動物用藥48項":["動物用藥-48項"],"四環黴素7項":["四環黴素-7項"],"硝基呋喃代謝物5項":["硝基呋喃代謝物-5項"],"孔雀綠、結晶紫及其代謝物":["孔雀綠、結晶紫及其代謝物"],"乙型受體素21項":["乙型受體素-21項"],"β-內醯胺類抗生素19項":["β-內醯胺類抗生素-19項"],"溶出試驗-水：過錳酸鉀消耗量":["溶出試驗-水:過錳酸鉀消耗量"],"溶出試驗-水：蒸發殘渣":["溶出試驗-水:蒸發殘渣"],"溶出試驗-4% 醋酸:蒸發殘渣":["溶出試驗-4%醋酸:蒸發殘渣"],"溶出試驗-正庚烷:蒸發殘渣":["溶出試驗-正庚烷:蒸發殘渣"],"溶出試驗-酒精:蒸發殘渣":["酒精:蒸發殘渣"],"材質試驗-鉛與鎘":["材質試驗-鉛與鎘"],"材質試驗-塑化劑8項(轉送)":["材質試驗-塑化劑8項(委合作實驗室）"],"芥酸":["芥酸"],"酸價":["酸價"],"總極性化合物":["總極性化合物"],"過氧化價":["過氧化價"],"順丁烯二酸酐":["順丁烯二酸"],"抗氧化劑":["抗氧化劑11項"],"揮發性鹽基態氮":["揮發性鹽基態氮(VBN)"],"亞硝酸鹽":["亞硝酸鹽(以NO2計)"],"水活性":["水活性"],"多環芳香族碳氫化合物(PAH4)(委外)":["多環芳香族碳氫化合物(註)(委合作實驗室）"],"三聚氰胺":["三聚氰胺"],"過氧化氫":["過氧化氫"],"丙烯醯胺":["丙烯醯胺"],"咖啡因":["咖啡因"],"二氧化硫":["二氧化硫"],"磷酸鹽(委外)":["食品中磷酸鹽(委合作實驗室）"],"組織胺":["組織胺"],"委外-膠原蛋白":["膠原蛋白(委合作實驗室）"],"色胺酸(委外)":["色胺酸(Tryptophane)(委合作實驗室)"],"蘇丹紅(委外)":["蘇丹紅四項(委合作實驗室)"],"過氧化苯甲醯":["過氧化苯甲醯"],"偶氮二甲醯胺":["偶氮二甲醯胺"],"內容量":["罐頭食品-內容量(CNS974)"],"氣味":["氣味","安定性試驗-氣味"],"色澤":["色澤"],"牛磺酸(委外)":["牛磺酸(委合作實驗室)"],"總三萜類(委外)":["總三萜(Totaltriterpenoid)(委合作實驗室)"],"SOD like (轉送)":["SOD-likeactivity(委合作實驗室)"],"總多酚(委外)":["總多酚(Totalpolyphenol)(委合作實驗室)"],"化粧品重金屬(轉送)":["化妝品-四項重金屬(砷、鉛、鎘、汞)"],"化粧品-防腐劑12項":["化妝品防腐劑12項","化妝品防腐劑12項：苯甲酸、己二烯酸、去水醋酸、對羥基苯甲酸、水楊酸、對羥苯甲酸甲酯、乙酯、丙酯、異丙酯、丁酯第二丁酯、異丁酯"],"化粧品-好氣性生菌數":["化妝品-好氣性生菌數"],"化粧品-大腸桿菌":["化妝品-大腸桿菌"],"化粧品-綠膿桿菌":["化妝品-綠膿桿菌"],"化粧品-金黃色葡萄球菌":["化妝品-金黃色葡萄球菌(定性)"],"化粧品-白色念球菌":["化妝品-白色念珠菌"],"化粧品-黴菌及酵母菌":["化妝品-黴菌&酵母菌"],"螢光增白劑":["食品用洗潔劑-螢光增白劑","螢光增白劑"],"黏度":["黏度(委合作實驗室)","安定性試驗-黏度"],"中藥-二氧化硫":["中藥-二氧化硫"],"中藥-黃麴毒素":["中藥-黃麴毒素"],"中藥-大腸桿菌":["中藥-大腸桿菌"],"中藥-沙門氏桿菌":["中藥-沙門氏菌"],"中藥-黴菌及酵母菌總數":["中藥-黴菌及酵母菌"],"中藥-綠膿桿菌":["中藥-綠膿桿菌"],"中藥-金黃色葡萄球菌":["中藥-金黃色葡萄球菌"],"中藥-膽鹽耐受性革蘭氏陰性菌":["中藥-膽鹽耐受性革蘭氏陰性菌"],"寵物-抗氧化劑":["寵物食品-抗氧化劑(衣索金(Ethoxyquin)、BHT、,BHA)"],"寵物-亞硝酸鈉":["寵物食品-亞硝酸鈉(以NO2計)"],"丙二醇(轉送)":["寵物食品-丙二醇(委合作實驗室)"],"重量":["罐頭食品-總重量(CNS974)"],"環氧乙烷(委外)":["環氧乙烷(委合作實驗室)"],"縮水甘油脂(委外)":["縮水甘油脂肪酸酯(委合作實驗室)"],"唾液酸":["唾液酸"],"OD-like  activity(委外)":["SOD-likeactivity超氧陰離子(Superoxidedismutase)(委合作實驗室)"],"總皂苷(轉送)":["人蔘總皂苷(TotalGinsenoside)(LC法)(委合作實驗室)","人蔘總皂苷(TotalGinsenoside) (呈色法)(委合作實驗室)"],"磷化氫(轉送)":["磷化氫(委合作實驗室)"],"包裝(盛裝)飲用水及食用冰塊中重金屬-鉛":["包裝(盛裝)飲用水-鉛"],"李斯特菌(CFU)":["單核細胞增生性李斯特菌(定量)"],"穀類重金屬-鉛、鎘、汞、砷":["穀類重金屬-鉛、鎘、汞、砷"],"多環芳香族碳氫化合物(PAH4)":["多環芳香族碳氫化合物-PAHs(苯(a)駢芘、苯(a)駢恩、苯(b)苯駢厄和chrysene之總和)"],"固形物含量":["罐頭食品-固形量(CNS974)"],"塑化劑九項":["塑化劑(9項)"],"中藥4大重金屬-砷、鎘、汞、鉛":["中藥重金屬四項(砷、鎘、鉛、汞)"],"(MS)重金屬-砷":["重金屬-總砷 (0.01ppm)"],"(MS)重金屬-汞":["ICP-MS- 汞(0.01ppm)"],"(OES)4大重金屬-鉛、鎘、汞、砷(2ppm)":["ICP-OES-4大重金屬 (2ppm)"],"化粧品-PH值":["酸鹼值(pH)","化粧品-PH值"],"3-單氯丙二醇(轉送)":["單氯丙二醇 (3-MCPD)"],"氯黴素類":["氯黴素-4項"],"水質-pH值":["水質-PH(NIEA)"]};
let ITEM_ALIAS_MAP_ = null; // key 正規化後的版本，第一次用到時才建立
function getItemAliasMap_() {
  if (!ITEM_ALIAS_MAP_) {
    ITEM_ALIAS_MAP_ = {};
    for (const k in ITEM_ALIAS_RAW) {
      const nk = inNorm(k);
      if (!nk) continue;
      ITEM_ALIAS_MAP_[nk] = (ITEM_ALIAS_MAP_[nk] || []).concat(ITEM_ALIAS_RAW[k]);
    }
  }
  return ITEM_ALIAS_MAP_;
}


// ---------- 名稱正規化與智慧比對 ----------
function inNorm(s) {
  s = String(s == null ? '' : s).trim();
  // Unicode 正規化（NFKC）：把 CJK 相容表意文字（例如某些舊系統／Word 貼上
  // 常見的相容字，如 U+F9D0「類」）統一轉成標準字（U+985E「類」），避免
  // 兩個字看起來一模一樣、卻因為底層碼位不同而比對不起來。
  s = s.normalize('NFKC');
  // 全形轉半形
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/[\s ]/g, '');
  s = s.replace(/[()\[\]{}．.·、,，'"“”‘’\-—_/\\]/g, '');
  return s;
}
const IN_SUFFIXES = ['股份有限公司', '企業有限公司', '實業有限公司', '食品有限公司', '有限公司', '企業社', '企業行', '實業社', '商行', '工作室', '農產行', '食品行', '水產行', '公司'];
function inCoreName(s) {
  let t = inNorm(s);
  for (const suf of IN_SUFFIXES) {
    if (t.endsWith(suf) && t.length > suf.length + 1) { t = t.slice(0, -suf.length); break; }
  }
  return t;
}

// 客戶名稱如果帶有括號（例如「國立屏東科技大學(動畜系館)」這種「機構(部門/
// 系館)」的寫法），代表這是某個機構底下特定的一個單位，跟只寫機構名稱本身
// （例如單純的「國立屏東科技大學」）並不是同一回事，不應該讓「機構名稱」
// 這種比較短的廠商名稱用「包含關係」模糊比對到它，比對到會誤導，例如
// 「國立屏東科技大學」不等於「國立屏東科技大學(動畜系館)」，兩者只在有
// 明確系館/部門名稱時才算比對得到。
function inHasBracketQualifier(s) {
  return /[()（）]/.test(String(s == null ? '' : s));
}

// 客戶名稱如果在「公司類型字尾」（股份有限公司、有限公司…）後面還接著其他
// 文字（例如「味全食品工業股份有限公司高雄廠」「會昌實業股份有限公司屏東
// 分公司」），代表這是總公司底下特定的分公司/分廠/營業處，跟只寫到公司
// 類型字尾為止的名稱本身（例如單純的「味全食品工業股份有限公司」）並不是
// 同一回事，道理跟括號部門/系館一樣：不應該讓「公司本名」這種比較短的
// 廠商名稱用「包含關係」模糊比對到分支機構，例如「味全食品工業股份有限
// 公司」不等於「味全食品工業股份有限公司高雄廠」，兩者只在名稱完全一致
// 時才算比對得到。
function inHasBranchQualifier(s) {
  const n = inNorm(s);
  for (const suf of IN_SUFFIXES) {
    const idx = n.indexOf(suf);
    if (idx !== -1 && idx + suf.length < n.length) return true;
  }
  return false;
}

// 建立客戶比對索引（每次載入資料時重建，確保吃到最新客戶資料庫）
function buildIncomingCustIndex() {
  const exact = new Map();   // 完整正規化名稱 -> cust
  const core = new Map();    // 去掉公司字尾 -> cust
  const coreList = [];       // 供「包含」比對用（帶括號部門/系館的名稱不放進來，避免誤比對）
  const custs = (typeof allCustomers === 'function') ? allCustomers() : (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []);
  for (const c of custs) {
    for (const nm of [c.name, c.short]) {
      if (!nm) continue;
      const n = inNorm(nm), k = inCoreName(nm);
      if (n && !exact.has(n)) exact.set(n, c);
      if (k && !core.has(k)) {
        core.set(k, c);
        if (!inHasBracketQualifier(nm) && !inHasBranchQualifier(nm)) coreList.push([k, c]);
      }
    }
  }
  return { exact, core, coreList };
}

// 廠商名稱 -> {cust, level}；level: 'exact' 完全符合 / 'fuzzy' 相似（包含關係）
function matchVendorToCustomer(vendor, idx, memo) {
  if (memo.has(vendor)) return memo.get(vendor);
  let result = null;
  const n = inNorm(vendor);
  if (n) {
    if (idx.exact.has(n)) result = { cust: idx.exact.get(n), level: 'exact' };
    else {
      const k = inCoreName(vendor);
      if (idx.core.has(k)) result = { cust: idx.core.get(k), level: 'exact' };
      else if (k.length >= 4) {
        for (const [ck, c] of idx.coreList) {
          if (ck.length >= 4 && (ck.includes(k) || k.includes(ck))) { result = { cust: c, level: 'fuzzy' }; break; }
        }
      }
    }
  }
  memo.set(vendor, result);
  return result;
}

// ---------- 報價單「每項檢驗單價」比對 ----------
// 報價單項目的 sample 欄位其實是「最少樣品量」（例如「100g」），不是樣品
// 名稱，不能拿來比對；真正該比對的是收樣紀錄的「取樣測項」對上報價單項目
// 的「品名」（item 欄位，例如「重金屬」「農藥411項」），抓到的才是那一項
// 檢驗真正的單價。同一個客戶名下可能有很多張報價單，全部一起搜尋，抓分數
// 最高、其次最新的那一項。
function buildQuoteIndexByCust() {
  const map = new Map();
  const list = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory : [];
  for (const q of list) {
    const k = inCoreName(q.company);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(q);
  }
  for (const arr of map.values()) arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return map;
}
// 把品名／測項名稱拆成關鍵字（用標點、括號、頓號等常見分隔符號切開），
// 用來在整串字完全不一樣、但其實講的是同一件事的時候（例如報價單品名多了
// 或少了幾個字、換了個講法）做「關鍵字比對」。長度小於 2 的字太容易誤判，
// 直接濾掉不用。
function inKeywords(s) {
  return inNorm(s)
    .replace(/[()（）]/g, '|')
    .split(/[、,，\/／\+\-&＆\|\s]+/)
    .map(k => k.trim())
    .filter(k => k.length >= 2);
}

// 品名比對分數：4 完全一致／3 整串互相包含／2 有關鍵字完全相同／
// 1 有關鍵字互相包含（最寬鬆的「找關鍵字比對」，分數最低、畫面上標「相似」）。
function itemMatchScore_(itemName, testItemName) {
  const b = inNorm(itemName);
  const t = inNorm(testItemName);
  if (!b || !t) return 0;
  if (b === t) return 4;
  if (b.includes(t) || t.includes(b)) return 3;
  const bKw = inKeywords(itemName);
  const tKw = inKeywords(testItemName);
  for (const k1 of bKw) {
    for (const k2 of tKw) {
      if (k1 === k2) return 2;
      if (k1.includes(k2) || k2.includes(k1)) return 1;
    }
  }
  return 0;
}

function findBestItemForRow(row, cust, quoteIdx) {
  const arr = quoteIdx.get(inCoreName(cust.name)) || quoteIdx.get(inCoreName(cust.short || '')) || [];
  if (!arr.length) return null;
  const testN = inNorm(row.test_item);
  if (!testN) return null;
  // 先查人工整理的對照表（ITEM_ALIAS_RAW／getItemAliasMap_）：這份是使用者
  // 自己核對過「取樣測項」實際對應到報價單裡哪個品名，比自動比對／關鍵字
  // 比對都可信，所以同一張報價單裡，只要對照表比對得到，就優先採用，不會
  // 被分數比較高的自動比對蓋過去。
  const aliasVariants = getItemAliasMap_()[testN] || null;
  // arr 已按日期新到舊排序。以「最新的報價單為主」：先看最新那張報價單裡
  // 有沒有比對得到的品項，只要有（哪怕只是關鍵字相似），就用那張的單價，
  // 不會因為某張更早的報價單分數比較高就跳去用舊的；只有最新那張完全找
  // 不到任何比對得到的品項時，才往下看次新的那一張，依此類推。
  for (const q of arr) {
    const items = Array.isArray(q.items) ? q.items : [];
    let best = null, bestScore = 0, bestViaAlias = false;
    for (const it of items) {
      let aliasScore = 0;
      if (aliasVariants) {
        for (const variant of aliasVariants) {
          const s = itemMatchScore_(it.item, variant);
          if (s > aliasScore) aliasScore = s;
        }
      }
      if (aliasScore > 0) {
        // 對照表比對到的，一律當作比任何純自動比對更高分（用 +10 墊底），
        // 這樣同一張報價單裡就算有其他品項自動比對分數更高，也不會蓋過
        // 對照表比對到的結果。
        const effScore = aliasScore + 10;
        if (!bestViaAlias || effScore > bestScore) { bestScore = effScore; best = { q, it, score: aliasScore, viaAlias: true }; bestViaAlias = true; }
        continue;
      }
      if (bestViaAlias) continue; // 這張報價單已經有對照表比對到的品項，不用再看純自動比對的
      const score = itemMatchScore_(it.item, row.test_item);
      if (score > bestScore) { bestScore = score; best = { q, it, score, viaAlias: false }; }
    }
    if (best) return best;
  }
  return null; // 這個客戶名下所有報價單都找不到任何比對得到的檢驗項目
}

// 算出某一筆收樣紀錄「目前應該顯示的金額」：手動輸入過的優先，否則用自動
// 比對到的單價，都沒有就是 none（畫面上會是空的可編輯輸入框）。
function getRowPriceInfo(x) {
  const ov = incomingAmountOverrides[incomingRowKey_(x.r)];
  if (ov && ov.amount != null && ov.amount !== '') {
    // 手動輸入的金額就是使用者自己打的數字，沒有未稅／含稅的區分資訊，
    // 兩邊都算同一個數字，不會另外幫忙猜測或調整。
    const v = Number(ov.amount);
    return { amount: v, amountUntaxed: v, source: 'manual', migratedAmbiguous: !!ov.migratedAmbiguous };
  }
  if (x.itemMatch) {
    const mq = x.itemMatch.q;
    const taxRate = Number(mq.taxRate) || 0;
    const untaxed = Number(x.itemMatch.it.price) || 0;
    // 報價單右下角如果有列稅金（稅率 > 0，代表這張報價單是含稅價），每個
    // 測項抓到的金額要自動換算成含稅價；如果這張報價單本身未稅／免稅
    // （稅率 = 0），金額維持原本抓到的優惠價，不用調整。四捨五入到整數，
    // 跟系統其他地方金額的進位規則一致。amount 是「畫面上顯示、可能已經
    // 含稅」的金額；amountUntaxed 是原始未稅單價，用來算「業績總金額」
    // 的未稅／含稅兩個數字分開顯示。
    const amount = taxRate > 0 ? Math.round(untaxed * (1 + taxRate / 100)) : untaxed;
    return {
      amount, amountUntaxed: untaxed,
      source: x.itemMatch.viaAlias ? 'dict' : (x.itemMatch.score >= 3 ? 'auto' : 'auto-fuzzy'),
      quoteNo: mq.quoteNo, date: mq.date, itemName: x.itemMatch.it.item,
    };
  }
  return { amount: null, amountUntaxed: null, source: 'none' };
}

// ---------- 資料載入 ----------
async function inFetchJson(path) {
  const url = INCOMING_BASE + path;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) return await r.json();
    throw new Error('HTTP ' + r.status);
  } catch (e) {
    // 若站台有登入保護，改帶認證 cookie 再試一次
    const r2 = await fetch(url, { cache: 'no-store', credentials: 'include' });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    return await r2.json();
  }
}

function inYmOptions() {
  const months = (incomingManifest && incomingManifest.months) ? incomingManifest.months.map(m => m.ym) : [];
  return months.slice().sort();
}

async function loadIncomingData(force) {
  if (incomingLoading) return;
  incomingLoading = true;
  const meta = document.getElementById('incomingMeta');
  const errBox = document.getElementById('incomingError');
  errBox.style.display = 'none';
  try {
    meta.textContent = '載入中...';
    if (!incomingManifest || force) {
      incomingManifest = await inFetchJson('manifest.json');
      const yms = inYmOptions();
      const selFrom = document.getElementById('inFromYm');
      const selTo = document.getElementById('inToYm');
      const prevFrom = selFrom.value, prevTo = selTo.value;
      selFrom.innerHTML = yms.map(y => '<option value="' + y + '">' + y + '</option>').join('');
      selTo.innerHTML = selFrom.innerHTML;
      // 預設載入最近 4 個月（目前即 4～7 月）
      const defFrom = yms[Math.max(0, yms.length - 4)] || yms[0];
      selFrom.value = (prevFrom && yms.includes(prevFrom)) ? prevFrom : defFrom;
      selTo.value = (prevTo && yms.includes(prevTo)) ? prevTo : yms[yms.length - 1];
    }
    const yms = inYmOptions();
    let from = document.getElementById('inFromYm').value, to = document.getElementById('inToYm').value;
    if (from > to) { const t = from; from = to; to = t; }
    const wanted = yms.filter(y => y >= from && y <= to);
    const monthObjs = incomingManifest.months.filter(m => wanted.includes(m.ym));
    const loaded = await Promise.all(monthObjs.map(async m => {
      if (!force && incomingMonthCache[m.ym]) return incomingMonthCache[m.ym];
      const rows = await inFetchJson(m.file);
      incomingMonthCache[m.ym] = Array.isArray(rows) ? rows : (rows.rows || []);
      return incomingMonthCache[m.ym];
    }));
    incomingLoadedYms = wanted;

    // 比對
    const idx = buildIncomingCustIndex();
    const quoteIdx = buildQuoteIndexByCust();
    const memo = new Map();
    const out = [];
    // 收樣紀錄總表來源資料本身有時候會把同一筆資料重複列出兩次（同一個
    // 報告號碼＋測項＋樣品名稱完全一樣的列出現兩次，不是分頁交界造成的，
    // 同一個月的檔案裡就會重複），如果沒有濾掉，筆數、金額加總都會被灌
    // 水（例如同一筆 $16,000 的測項被算成兩次變 $32,000）。這裡用「報告
    // 號碼＋測項＋樣品名稱」當唯一 key，同一個 key 只留第一筆。
    const seenKeys = new Set();
    for (const rows of loaded) {
      for (const r of rows) {
        const dupKey = (r.report_no || '') + '' + (r.test_item || '') + '' + (r.sample || '');
        if (seenKeys.has(dupKey)) continue;
        seenKeys.add(dupKey);
        const m = r.vendor ? matchVendorToCustomer(String(r.vendor), idx, memo) : null;
        let itemMatch = null;
        if (m) itemMatch = findBestItemForRow(r, m.cust, quoteIdx);
        out.push({ r, cust: m ? m.cust : null, level: m ? m.level : null, itemMatch });
      }
    }
    // 依進件日期新→舊
    out.sort((a, b) => String(b.r.in_date || '').localeCompare(String(a.r.in_date || '')));
    incomingRows = out;

    // 把舊格式（只用報告號碼記手動金額）的資料搬遷成新格式，搬遷完要記得
    // 回寫雲端，不然下次重新整理又會讀到舊格式。
    if (migrateLegacyIncomingAmountOverrides_(incomingRows)) syncIncomingAmountsToCloud();

    // 客戶下拉選單
    const counts = new Map();
    for (const x of incomingRows) if (x.cust) counts.set(x.cust.name, (counts.get(x.cust.name) || 0) + 1);
    const sel = document.getElementById('inCustFilter');
    const prev = sel.value;
    const opts = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([nm, c]) => '<option value="' + nm.replace(/"/g, '&quot;') + '">' + nm + '（' + c + '）</option>');
    sel.innerHTML = '<option value="">全部客戶</option>' + opts.join('');
    if ([...counts.keys()].includes(prev)) sel.value = prev;

    incomingQuoteCountAtLoad = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory.length : 0;
    incomingPage = 1;
    renderIncomingTable();
  } catch (e) {
    meta.textContent = '載入失敗';
    errBox.style.display = '';
    errBox.innerHTML = '無法讀取收樣紀錄總表資料（' + String(e.message || e) + '）。<br>' +
      '若是第一次使用：請先在收樣紀錄總表的網站專案加入 <b>_headers</b> 檔並重新部署（開放本網站跨網域讀取），完成後再按「重新載入」。';
  } finally {
    incomingLoading = false;
  }
}

// ---------- 畫面 ----------
function inEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 每一欄各自的篩選字（表格標題下面那排篩選輸入框對應的值）：報告號碼／
// 廠商名稱／對應客戶／樣品名稱／取樣測項／進件日期／預定出件／報告出件
// 日／報價單號／報價金額，全部都是「不分大小寫、只要有包含到就算」的
// 篩選（跟最上面既有的搜尋框邏輯一致），每一欄互相是「且」的關係。
let incomingColFilters = {
  reportNo: '', vendor: '', cust: '', sample: '', testItem: '',
  inDate: '', dueDate: '', reportDate: '', quoteNo: '', amount: '',
};
function incomingFilteredRows() {
  const q = inNorm(document.getElementById('inSearch').value);
  const onlyMatched = document.getElementById('inOnlyMatched').checked;
  const custFilter = document.getElementById('inCustFilter').value;
  const cf = incomingColFilters;
  const needInfo = !!(q || cf.quoteNo || cf.amount);
  return incomingRows.filter(x => {
    if (onlyMatched && !x.cust) return false;
    if (custFilter && (!x.cust || x.cust.name !== custFilter)) return false;
    const info = needInfo ? getRowPriceInfo(x) : null;
    if (q) {
      const hay = inNorm([x.r.report_no, x.r.vendor, x.r.sample, x.r.test_item, x.cust ? x.cust.name : '', info.quoteNo || ''].join('|'));
      if (!hay.includes(q)) return false;
    }
    if (cf.reportNo && !inNorm(x.r.report_no).includes(inNorm(cf.reportNo))) return false;
    if (cf.vendor && !inNorm(x.r.vendor).includes(inNorm(cf.vendor))) return false;
    if (cf.cust && !inNorm(x.cust ? x.cust.name : '').includes(inNorm(cf.cust))) return false;
    if (cf.sample && !inNorm(x.r.sample).includes(inNorm(cf.sample))) return false;
    if (cf.testItem && !inNorm(x.r.test_item).includes(inNorm(cf.testItem))) return false;
    if (cf.inDate && !String(x.r.in_date || '').includes(cf.inDate)) return false;
    if (cf.dueDate && !String(x.r.due_date || '').includes(cf.dueDate)) return false;
    if (cf.reportDate && !String(x.r.report_date || '').includes(cf.reportDate)) return false;
    if (cf.quoteNo && !inNorm(info.quoteNo || '').includes(inNorm(cf.quoteNo))) return false;
    // 報價金額這欄是下拉選單，不是打字篩選：'blank' 篩「還沒有金額」的
    // （方便手動填價），'has' 篩「已經有金額」的，空字串（預設）不篩選。
    if (cf.amount === 'blank' && info.amount != null) return false;
    if (cf.amount === 'has' && info.amount == null) return false;
    return true;
  });
}

// 收樣紀錄表格的「每欄篩選」輸入框、業績總金額統計、以及表格上方的分頁
// ——這三個都是用 JS 動態插入 DOM，不是寫死在主頁面 HTML 裡，這樣之後要
// 調整只需要改這支檔案，不用去動主頁面的 HTML 結構。只在第一次渲染收樣
// 紀錄表格時執行一次，之後表格重繪（body.innerHTML）不會影響到這些已經
// 插入好的元素。
let incomingUiEnhanced = false;
function setupIncomingUiEnhancements() {
  if (incomingUiEnhanced) return;
  const tbody = document.getElementById('incomingTableBody');
  if (!tbody) return;
  const table = tbody.closest('table');
  const thead = table ? table.querySelector('thead') : null;
  const headerRow = thead ? thead.querySelector('tr') : null;
  if (!table || !thead || !headerRow) return;
  incomingUiEnhanced = true;

  // 表格原本套用 table-layout:fixed（十欄平分寬度），報告號碼／報價單號
  // 這種比較長的英數字代碼會被切掉、超出格子。這裡只針對這張表格改成
  // auto（欄寬跟著內容自動調整），不會影響到頁面上其他也用同一個
  // db-table 樣式的表格。
  table.style.tableLayout = 'auto';

  // 表格外層的 .table-scroll 容器原本 overflow 是 visible，加了每欄篩選、
  // 欄寬變寬（auto）之後，只要總寬度超過容器，內容就會直接「溢出」到
  // 白色卡片外面，看起來很醜。這裡只針對這張表格的外層容器加上
  // overflow-x:auto，超出的部分改成在卡片內部出現水平捲軸，不會再穿出
  // 卡片邊界；沒有超出時完全不會看到捲軸，不影響原本版面。
  const scrollWrap = table.closest('.table-scroll') || table.parentElement;
  if (scrollWrap) {
    scrollWrap.style.overflowX = 'auto';
    scrollWrap.style.maxWidth = '100%';
    scrollWrap.style.paddingBottom = '4px';
  }

  // 標題列文字太長（例如「廠商名稱（收樣）」「對應客戶（報價系統）」）會
  // 把欄位撐得很寬，改成比較短的字，完整說明改放在滑鼠移過去的 title
  // 提示裡，資訊不會少，但欄位可以窄很多，讓整張表更容易一次塞進白色卡
  // 片裡、不用再左右拉。
  const headerShortLabels = {
    '廠商名稱（收樣）': ['廠商名稱', '收樣紀錄總表裡的廠商名稱'],
    '對應客戶（報價系統）': ['對應客戶', '比對到的報價系統客戶名稱'],
  };
  [...headerRow.children].forEach(th => {
    const full = th.textContent.trim();
    const short = headerShortLabels[full];
    if (short) { th.textContent = short[0]; th.title = short[1]; }
  });

  // 1) 每欄篩選：在標題列下面插入一列篩選輸入框（報價金額是下拉選單，
  //    其他是文字輸入框）。這裡的欄寬盡量抓緊一點：報告號碼／報價單號／
  //    日期／報價金額這幾欄內容不會換行，寬度要剛好夠放；廠商名稱／對應
  //    客戶／樣品名稱／取樣測項這幾欄內容本來就會自動換行（不會被截
  //    斷），窄一點只是多幾行，不會不見，所以可以抓比較窄的寬度，讓整
  //    張表加起來盡量塞進卡片裡，不用左右捲動。
  const filterCols = [
    ['reportNo', '篩選報告號碼', '100px'], ['vendor', '篩選廠商名稱', '80px'],
    ['cust', '篩選對應客戶', '80px'], ['sample', '篩選樣品名稱', '72px'],
    ['testItem', '篩選取樣測項', '82px'], ['inDate', '篩選進件日期', '70px'],
    ['dueDate', '篩選預定出件', '70px'], ['reportDate', '篩選報告出件', '70px'],
    ['quoteNo', '篩選報價單號', '112px'], ['amount', null, '92px'],
  ];
  const filterRow = document.createElement('tr');
  filterRow.className = 'incoming-col-filter-row';
  filterCols.forEach(([key, ph, minW]) => {
    const th = document.createElement('th');
    th.style.fontWeight = 'normal';
    th.style.padding = '3px 2px';
    th.style.minWidth = minW;
    let el;
    if (key === 'amount') {
      el = document.createElement('select');
      el.innerHTML = '<option value="">報價金額：全部</option>' +
        '<option value="blank">只看空白（未填）</option>' +
        '<option value="has">只看已有金額</option>';
    } else {
      el = document.createElement('input');
      el.type = 'text';
      el.placeholder = ph;
    }
    el.dataset.colFilter = key;
    el.style.width = '100%';
    el.style.boxSizing = 'border-box';
    el.style.fontSize = '11px';
    th.appendChild(el);
    filterRow.appendChild(th);
  });
  headerRow.insertAdjacentElement('afterend', filterRow);
  const onColFilterChange = (e) => {
    const el = e.target.closest('[data-col-filter]');
    if (!el) return;
    incomingColFilters[el.dataset.colFilter] = el.value;
    incomingPage = 1;
    renderIncomingTable();
  };
  filterRow.addEventListener('input', onColFilterChange);
  filterRow.addEventListener('change', onColFilterChange);

  // 資料儲存格的欄寬、內距、字級都收緊一點（跟篩選列的欄寬對應），這樣
  // 十個欄位加起來才有機會整張塞進卡片裡，不用再左右拉。報告號碼／報價
  // 單號／日期／報價金額這幾欄內容不換行，一定要留夠寬度；其他欄位內容
  // 本來就會換行，窄一點只是多幾行、資料不會不見。
  // 表格重繪（body.innerHTML）不會動到這個 <style>，只要設定一次即可。
  const styleTag = document.createElement('style');
  styleTag.textContent =
    '#incomingTableBody td{padding:4px 5px;font-size:12px;} ' +
    '#incomingTableBody td:nth-child(1){min-width:100px;} ' +
    '#incomingTableBody td:nth-child(2){min-width:80px;} ' +
    '#incomingTableBody td:nth-child(3){min-width:80px;} ' +
    '#incomingTableBody td:nth-child(4){min-width:72px;} ' +
    '#incomingTableBody td:nth-child(5){min-width:82px;} ' +
    '#incomingTableBody td:nth-child(6){min-width:70px;} ' +
    '#incomingTableBody td:nth-child(7){min-width:70px;} ' +
    '#incomingTableBody td:nth-child(8){min-width:70px;} ' +
    '#incomingTableBody td:nth-child(9){min-width:112px;} ' +
    '#incomingTableBody td:nth-child(10){min-width:92px;} ' +
    '#incomingPagination, #incomingPaginationTop{text-align:left;}';
  document.head.appendChild(styleTag);

  // 2) 業績總金額：跟著目前篩選條件（月份、客戶、搜尋、每欄篩選…）即時
  //    變動，未稅／含稅分開顯示，不是單一固定寫死的總數。
  const metaEl = document.getElementById('incomingMeta');
  if (metaEl && !document.getElementById('incomingRevenueTotal')) {
    const box = document.createElement('div');
    box.id = 'incomingRevenueTotal';
    box.style.cssText = 'margin:8px 0;display:flex;gap:24px;flex-wrap:wrap;text-align:left;';
    metaEl.insertAdjacentElement('afterend', box);
  }

  // 3) 表格上方也放一份分頁（跟表格下方原本就有的那份同步顯示同一頁數）。
  //    明確靠左對齊、拿掉多餘留白，排版緊湊一點。
  if (!document.getElementById('incomingPaginationTop')) {
    const topPag = document.createElement('div');
    topPag.id = 'incomingPaginationTop';
    topPag.className = 'incoming-pagination-top';
    topPag.style.cssText = 'margin:6px 0;text-align:left;';
    table.insertAdjacentElement('beforebegin', topPag);
  }
}

// 收樣資料表格的金額欄位是可編輯輸入框，用事件代理（而不是每一列各自綁
// inline onclick／onchange）比較安全，也不用擔心報告號碼裡出現特殊字元
// 需要跳脫。這個函式只需要在分頁第一次渲染時掛一次。
let incomingAmountDelegated = false;
function setupIncomingAmountDelegation() {
  if (incomingAmountDelegated) return;
  const body = document.getElementById('incomingTableBody');
  if (!body) return;
  incomingAmountDelegated = true;
  body.addEventListener('change', (e) => {
    const el = e.target.closest('.incoming-amt-input');
    if (!el) return;
    onIncomingAmountChange(inRowKeyFromAttr_(el.dataset.rowkey), el.value);
  });
  body.addEventListener('click', (e) => {
    const el = e.target.closest('.incoming-amt-clear');
    if (el) { clearIncomingAmount(inRowKeyFromAttr_(el.dataset.rowkey)); return; }
  });
}
// data-rowkey 屬性存的是 rowKey 經過 encodeURIComponent 之後的版本（rowKey
// 內含報告號碼＋測項＋樣品名稱之間的分隔字元，直接放進 HTML 屬性不放心，
// 用 encodeURIComponent 編碼過比較保險），這裡統一解碼還原。
function inRowKeyFromAttr_(attrVal) {
  try { return decodeURIComponent(attrVal || ''); } catch (e) { return attrVal || ''; }
}
function onIncomingAmountChange(rowKey, rawValue) {
  const v = String(rawValue == null ? '' : rawValue).trim();
  if (v === '') {
    delete incomingAmountOverrides[rowKey];
  } else {
    const num = parseFloat(v);
    if (isNaN(num)) { alert('請輸入數字'); renderIncomingTable(); return; }
    // 同一個報告號碼底下可能有好幾列（好幾個測項），一定要連測項／樣品名
    // 稱一起比對，才不會把金額誤填到「同一份報告的其他測項」上面去。
    const x = incomingRows.find(x => incomingRowKey_(x.r) === rowKey);
    incomingAmountOverrides[rowKey] = {
      amount: num,
      reportNo: x ? (x.r.report_no || '') : '',
      testItem: x ? (x.r.test_item || '') : '',
      sample: x ? (x.r.sample || '') : '',
      vendor: x ? (x.r.vendor || '') : '',
      customer: x && x.cust ? x.cust.name : '',
      updatedAt: nowIso(),
    };
  }
  renderIncomingTable();
  syncIncomingAmountsToCloud();
}
function clearIncomingAmount(rowKey) {
  delete incomingAmountOverrides[rowKey];
  renderIncomingTable();
  syncIncomingAmountsToCloud();
}

// 每日進件彙總：把目前篩選條件下看得到的收樣紀錄，依「進件日期」分組，
// 顯示當天有哪些客戶進件（含各客戶當天筆數）以及當天總金額。金額算法比
// 照畫面上其他地方：沒抓到金額、也沒手動輸入的列當 0 計算，之後有金額
// 了會自動更新，不用重新整理頁面。
function renderIncomingDailySummary(list) {
  const box = document.getElementById('incomingDailySummary');
  if (!box) return;
  if (!list.length) { box.innerHTML = ''; return; }
  const byDate = new Map();
  for (const x of list) {
    const d = x.r.in_date || '（無日期）';
    if (!byDate.has(d)) byDate.set(d, { rows: [], custCounts: new Map() });
    const g = byDate.get(d);
    g.rows.push(x);
    const custName = x.cust ? x.cust.name : (x.r.vendor || '（未比對客戶）');
    g.custCounts.set(custName, (g.custCounts.get(custName) || 0) + 1);
  }
  const dates = Array.from(byDate.keys()).sort().reverse();
  const fmtNum = (n) => (typeof fmt === 'function' ? fmt(n) : ('$' + n));
  const rowsHtml = dates.map(d => {
    const g = byDate.get(d);
    let untaxedTotal = 0, taxedTotal = 0;
    for (const x of g.rows) {
      const info = getRowPriceInfo(x);
      const amt = info.amount != null ? info.amount : 0;
      const amtUntaxed = info.amountUntaxed != null ? info.amountUntaxed : amt;
      taxedTotal += amt;
      untaxedTotal += amtUntaxed;
    }
    const custList = Array.from(g.custCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, cnt]) => inEsc(name) + (cnt > 1 ? '×' + cnt : ''))
      .join('、');
    return '<tr>' +
      '<td class="nowrap">' + inEsc(d) + '</td>' +
      '<td>' + custList + '</td>' +
      '<td class="nowrap">' + g.rows.length + ' 筆</td>' +
      '<td class="nowrap">' + fmtNum(untaxedTotal) + '</td>' +
      '<td class="nowrap">' + fmtNum(taxedTotal) + '</td>' +
      '</tr>';
  }).join('');
  box.innerHTML =
    '<div class="table-scroll" style="border:1px solid #e0e0e0;border-radius:4px;">' +
    '<table class="db-table" style="font-size:12px;"><thead><tr>' +
    '<th style="width:12%;">進件日期</th><th>當日客戶（進件筆數）</th><th style="width:8%;">進件筆數</th>' +
    '<th style="width:13%;">當日總金額（未稅）</th><th style="width:13%;">當日總金額（含稅）</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

// 每日進件彙總頁的篩選欄使用獨立的一組 DOM 元素（id 前綴 inDaily），但
// 篩選邏輯完全共用「收樣紀錄」頁面既有的 #in... 主控制項，兩邊只是畫面
// 分開、狀態是同一份。每日彙總頁的控制項 onchange/oninput 會先把值寫回
// 主控制項並觸發 loadIncomingData()／renderIncomingTable()，這個函式則
// 在每次 renderIncomingTable() 執行時，把主控制項目前的月份選項、選取
// 值、客戶清單、搜尋字、勾選狀態，單向鏡射回每日彙總頁的控制項，讓兩頁
// 畫面隨時保持一致；用 document.activeElement 跳過使用者正在操作中的
// 那個元素，避免游標被打斷。
function syncIncomingDailyControls() {
  const pairs = [
    ['inFromYm', 'inDailyFromYm', 'select'],
    ['inToYm', 'inDailyToYm', 'select'],
    ['inCustFilter', 'inDailyCustFilter', 'select'],
    ['inSearch', 'inDailySearch', 'text'],
    ['inOnlyMatched', 'inDailyOnlyMatched', 'checkbox'],
  ];
  const active = document.activeElement;
  for (const [mainId, dailyId, kind] of pairs) {
    const main = document.getElementById(mainId);
    const daily = document.getElementById(dailyId);
    if (!main || !daily || daily === active) continue;
    if (kind === 'select') {
      if (daily.innerHTML !== main.innerHTML) daily.innerHTML = main.innerHTML;
      if (daily.value !== main.value) daily.value = main.value;
    } else if (kind === 'checkbox') {
      daily.checked = main.checked;
    } else {
      daily.value = main.value;
    }
  }
}

function renderIncomingTable() {
  setupIncomingAmountDelegation();
  setupIncomingUiEnhancements();
  const body = document.getElementById('incomingTableBody');
  const meta = document.getElementById('incomingMeta');
  const list = incomingFilteredRows();
  renderIncomingDailySummary(list);
  syncIncomingDailyControls();
  const matchedAll = incomingRows.filter(x => x.cust);
  const custSet = new Set(matchedAll.map(x => x.cust.name));
  const priced = incomingRows.map(getRowPriceInfo).filter(p => p.amount != null);
  const pricedTotal = priced.reduce((s, p) => s + p.amount, 0);
  meta.textContent = '月份 ' + (incomingLoadedYms.join('、') || '—') + '：收樣共 ' + incomingRows.length +
    ' 筆；比對到報價客戶 ' + matchedAll.length + ' 筆（' + custSet.size + ' 個客戶）；' +
    '已有金額 ' + priced.length + ' 筆，合計 ' + (typeof fmt === 'function' ? fmt(pricedTotal) : ('$' + pricedTotal)) +
    '；目前顯示 ' + list.length + ' 筆';

  // 業績總金額：只算「目前篩選條件下」看得到的這些列（不受分頁影響，是
  // 全部符合篩選的加總），月份範圍、客戶、搜尋、每欄篩選改變時都會跟著
  // 重新計算。未稅／含稅分開顯示——未稅是抓到的原始優惠價加總，含稅是
  // 换算過（若該張報價單有稅率）之後實際顯示在報價金額欄的數字加總。
  const revBox = document.getElementById('incomingRevenueTotal');
  if (revBox) {
    const filteredPriced = list.map(getRowPriceInfo).filter(p => p.amount != null);
    const untaxedTotal = filteredPriced.reduce((s, p) => s + (p.amountUntaxed != null ? p.amountUntaxed : p.amount), 0);
    const taxedTotal = filteredPriced.reduce((s, p) => s + p.amount, 0);
    const fmtNum = (n) => (typeof fmt === 'function' ? fmt(n) : ('$' + n));
    revBox.innerHTML =
      '<div><span style="color:#666;font-size:13px;">業績總金額（未稅）</span><br>' +
      '<span style="font-size:18px;font-weight:bold;color:#1565c0;">' + fmtNum(untaxedTotal) + '</span></div>' +
      '<div><span style="color:#666;font-size:13px;">業績總金額（含稅）</span><br>' +
      '<span style="font-size:18px;font-weight:bold;color:#c62828;">' + fmtNum(taxedTotal) + '</span></div>' +
      '<div style="align-self:flex-end;color:#999;font-size:12px;">（目前篩選條件下 ' + filteredPriced.length + ' 筆有金額）</div>';
  }

  const totalPages = Math.max(1, Math.ceil(list.length / INCOMING_PAGE_SIZE));
  if (incomingPage > totalPages) incomingPage = totalPages;
  const pageItems = list.slice((incomingPage - 1) * INCOMING_PAGE_SIZE, incomingPage * INCOMING_PAGE_SIZE);

  body.innerHTML = pageItems.map(x => {
    const r = x.r;
    let custCell = '<span style="color:#999;">—</span>';
    if (x.cust) {
      const badge = x.level === 'exact'
        ? '<span style="background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;font-size:12px;margin-left:4px;">符合</span>'
        : '<span style="background:#fff3e0;color:#e65100;border-radius:4px;padding:1px 6px;font-size:12px;margin-left:4px;">相似</span>';
      custCell = inEsc(x.cust.name) + badge;
    }

    const info = getRowPriceInfo(x);
    let quoteNoCell = '<span style="color:#999;">—</span>';
    if (info.source === 'auto' || info.source === 'auto-fuzzy' || info.source === 'dict') {
      quoteNoCell = inEsc(info.quoteNo || '');
    } else if (info.source === 'manual') {
      quoteNoCell = '<span style="color:#999;">（手動輸入）</span>';
    }

    // 手動輸入標記／清除鈕／需確認提醒都改成小圖示＋title 提示，不要用長
    // 文字，避免這欄被撐得比其他欄寬很多，導致整張表又要左右拉。
    const rowKeyAttr = encodeURIComponent(incomingRowKey_(r));
    const inputVal = info.amount != null ? info.amount : '';
    let amtCell = '<input type="number" class="incoming-amt-input" data-rowkey="' + rowKeyAttr + '" value="' + inEsc(inputVal) + '" placeholder="輸入金額" style="width:70px;">';
    if (info.source === 'manual') {
      amtCell += '<button type="button" class="incoming-amt-clear" data-rowkey="' + rowKeyAttr + '" title="手動輸入的金額，點這裡清除，' +
        (x.itemMatch ? '恢復自動比對的金額' : '清空') + '" style="border:none;background:none;color:#1565c0;cursor:pointer;padding:0 0 0 2px;font-size:12px;">✕</button>';
      if (info.migratedAmbiguous) {
        amtCell += '<span style="color:#e65100;font-size:11px;cursor:help;padding-left:2px;" ' +
          'title="這是舊資料搬過來的金額：同一個報告號碼底下有好幾個測項，舊資料沒有記錄原本是打給哪一項，' +
          '所以先套用到全部測項上，請確認這筆金額是否正確，不對的話請重新輸入">⚠</span>';
      }
    }

    return '<tr>' +
      '<td class="nowrap">' + inEsc(r.report_no) + '</td>' +
      '<td>' + inEsc(r.vendor) + '</td>' +
      '<td>' + custCell + '</td>' +
      '<td>' + inEsc(r.sample) + '</td>' +
      '<td>' + inEsc(r.test_item) + '</td>' +
      '<td class="nowrap">' + inEsc(r.in_date) + '</td>' +
      '<td class="nowrap">' + inEsc(r.due_date) + '</td>' +
      '<td class="nowrap">' + inEsc(r.report_date) + '</td>' +
      '<td class="nowrap">' + quoteNoCell + '</td>' +
      '<td class="nowrap">' + amtCell + '</td>' +
      '</tr>';
  }).join('');

  const pagHtml = totalPages <= 1 ? '' :
    '<button class="btn-ghost" ' + (incomingPage <= 1 ? 'disabled' : '') + ' onclick="incomingPage--; renderIncomingTable()">上一頁</button>' +
    '<span style="margin:0 10px;">第 ' + incomingPage + ' / ' + totalPages + ' 頁</span>' +
    '<button class="btn-ghost" ' + (incomingPage >= totalPages ? 'disabled' : '') + ' onclick="incomingPage++; renderIncomingTable()">下一頁</button>';
  // 上下都放一份分頁按鈕，方便長清單捲到最下面時也能直接翻頁。
  const pag = document.getElementById('incomingPagination');
  if (pag) pag.innerHTML = pagHtml;
  const pagTop = document.getElementById('incomingPaginationTop');
  if (pagTop) pagTop.innerHTML = pagHtml;
}

let incomingQuoteCountAtLoad = -1;
function renderIncomingPage() {
  const qc = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory.length : 0;
  if (!incomingLoading && (!incomingRows.length || qc !== incomingQuoteCountAtLoad)) loadIncomingData();
  else renderIncomingTable();
}
function renderIncomingDailyPage() {
  const qc = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory.length : 0;
  if (!incomingLoading && (!incomingRows.length || qc !== incomingQuoteCountAtLoad)) loadIncomingData();
  else renderIncomingDailySummary(incomingFilteredRows());
}

function exportIncomingMatched() {
  if (typeof XLSX === 'undefined') { alert('此頁面未載入 Excel 元件，無法匯出'); return; }
  const list = incomingFilteredRows();
  if (!list.length) { alert('目前沒有可匯出的資料'); return; }
  const rows = list.map(x => {
    const info = getRowPriceInfo(x);
    const sourceLabel = { auto: '自動比對', 'auto-fuzzy': '相似比對', dict: '對照表比對', manual: '手動輸入', none: '' }[info.source] || '';
    return {
      '報告號碼': x.r.report_no || '', '廠商名稱': x.r.vendor || '',
      '對應客戶': x.cust ? x.cust.name : '', '比對方式': x.cust ? (x.level === 'exact' ? '符合' : '相似') : '',
      '樣品名稱': x.r.sample || '', '取樣測項': x.r.test_item || '',
      '進件日期': x.r.in_date || '', '預定出件日期': x.r.due_date || '', '電子報告出件日': x.r.report_date || '',
      '報價單號': info.quoteNo || '', '比對到的檢驗項目': info.itemName || '',
      '報價金額': info.amount != null ? info.amount : '', '金額來源': sourceLabel,
    };
  });
  const totalAmt = rows.reduce((s, r) => s + (typeof r['報價金額'] === 'number' ? r['報價金額'] : 0), 0);
  rows.push({ '報告號碼': '合計', '報價金額': totalAmt });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '收樣比對');
  XLSX.writeFile(wb, '收樣紀錄比對_' + incomingLoadedYms.join('-') + '.xlsx');
}

// ---------- 手動金額：雲端同步（跟客戶/檢驗項目/報價記錄/常用備註同一套機制） ----------
// 雲端試算表分頁現在多存兩欄 testItem／sample（原本只有 reportNo），這樣
// 才能唯一對應到「報告號碼底下的哪一列」，不會同一份報告的其他測項也被
// 一起連動改到金額。
function incomingAmountsToCloudRows() {
  return Object.keys(incomingAmountOverrides).map(rowKey => {
    const o = incomingAmountOverrides[rowKey] || {};
    return {
      reportNo: o.reportNo || '', testItem: o.testItem || '', sample: o.sample || '',
      vendor: o.vendor || '', customer: o.customer || '',
      amount: (o.amount != null ? o.amount : ''), updatedAt: o.updatedAt || nowIso(),
    };
  });
}
function applyCloudIncomingAmountRows(rows) {
  const map = {};
  const legacy = {};
  (rows || []).forEach(r => {
    const reportNo = cloudStr(r.reportNo);
    if (!reportNo) return;
    const amt = (r.amount === '' || r.amount == null) ? null : parseFloat(r.amount);
    if (amt == null || isNaN(amt)) return;
    // 用 testItem 這個 key 是否存在（不是是否有值）來判斷是不是舊格式：新格
    // 式一定會送 testItem／sample 這兩個欄位（即使值是空字串），舊格式完全
    // 沒有這兩個欄位。
    if ('testItem' in r || 'sample' in r) {
      const testItem = cloudStr(r.testItem), sample = cloudStr(r.sample);
      const rowKey = incomingRowKey_({ report_no: reportNo, test_item: testItem, sample: sample });
      map[rowKey] = {
        amount: amt, reportNo: reportNo, testItem: testItem, sample: sample,
        vendor: cloudStr(r.vendor), customer: cloudStr(r.customer), updatedAt: cloudStr(r.updatedAt),
      };
    } else {
      legacy[reportNo] = { amount: amt, vendor: cloudStr(r.vendor), customer: cloudStr(r.customer), updatedAt: cloudStr(r.updatedAt) };
    }
  });
  incomingAmountOverrides = map;
  incomingLegacyAmountOverrides = legacy;
}
// 舊格式（只用報告號碼記手動金額）搬遷成新格式（報告號碼＋測項＋樣品名
// 稱）：要等收樣資料（incomingRows）載入後，才知道這個報告號碼底下實際
// 有哪些列。同一報告號碼底下只有一列的，可以直接、準確地搬過去；有好幾
// 列（好幾個測項）的，舊資料沒辦法判斷原本是打給哪一項，為了不讓已經打
// 過的金額憑空消失，先套用到全部列上，並標記 migratedAmbiguous，畫面上
// 會顯示「⚠️需確認」提醒使用者個別重新確認。
function migrateLegacyIncomingAmountOverrides_(rows) {
  const pendingKeys = Object.keys(incomingLegacyAmountOverrides);
  if (!pendingKeys.length) return false;
  let migrated = false;
  pendingKeys.forEach(reportNo => {
    const ov = incomingLegacyAmountOverrides[reportNo];
    const matches = rows.filter(x => x.r.report_no === reportNo);
    if (!matches.length) return; // 目前載入的月份範圍內沒有對應的收樣紀錄，先不處理，之後月份範圍變了再試
    matches.forEach(x => {
      const rowKey = incomingRowKey_(x.r);
      incomingAmountOverrides[rowKey] = {
        amount: ov.amount, reportNo: reportNo, testItem: x.r.test_item || '', sample: x.r.sample || '',
        vendor: ov.vendor, customer: ov.customer, updatedAt: ov.updatedAt,
        migratedAmbiguous: matches.length > 1,
      };
    });
    delete incomingLegacyAmountOverrides[reportNo];
    migrated = true;
  });
  return migrated;
}
async function syncIncomingAmountsToCloud() {
  if (!CLOUD_ENABLED) return;
  cloudSyncState = 'syncing'; updateCloudStatusUI();
  try {
    await cloudPost('incomingAmounts', incomingAmountsToCloudRows());
    cloudSyncState = 'ok';
  } catch (err) {
    cloudSyncState = 'error'; cloudLastError = String((err && err.message) || err);
  }
  updateCloudStatusUI();
}
